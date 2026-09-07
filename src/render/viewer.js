import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { diffSelection, selectAcross } from '../lod/selector.js';
import { PointsMaterialPool } from './pointsMaterial.js';
import { PRESETS, getPreset } from './presets.js';
import { DioramaRenderer } from './diorama.js';
import { histogram } from '../analysis/classStats.js';

/**
 * Rendu du nuage avec niveau de détail piloté par la caméra.
 *
 * La scène est exprimée dans le repère local de la dalle (origine = centre de
 * l'octree) : les coordonnées Lambert-93 absolues ne survivraient pas à un
 * Float32, qui n'y offre qu'un pas de 50 cm.
 */
export class Viewer {
  constructor(canvas, { onRequestNodes, pointBudget = 4_000_000, minScreenError = 1.5 } = {}) {
    this.canvas = canvas;
    this.onRequestNodes = onRequestNodes;
    this.pointBudget = pointBudget;
    this.minScreenError = minScreenError;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setClearColor(0x080a0e, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 1, 40_000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(700, -700, 520);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;

    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.materials = new PointsMaterialPool();
    this.diorama = new DioramaRenderer(this.renderer);
    this.dioramaOn = false;
    this.plinth = null;
    this.clipRadius = 450;
    this.clipCenter = [0, 0];
    this.clipShape = null;
    this.pointScale = 1;
    this.preset = getPreset('lecture');
    this.presetName = 'lecture';
    // Toutes les dalles partagent une seule origine de scene, celle de la
    // premiere chargee. Chacune garde en revanche son propre octree : son
    // centre est exprime par rapport a cette origine commune.
    this.origin = null;
    this.tiles = new Map(); // cle de dalle -> { tile, nodes, localCenter }
    this.loaded = new Map(); // uid (dalle|noeud) -> THREE.Points
    this.classCounts = new Map();
    this.pending = new Set();
    this.frustum = new THREE.Frustum();
    this.matrix = new THREE.Matrix4();
    this.box = new THREE.Box3();

    this.stats = {
      pointsInScene: 0,
      nodesInScene: 0,
      requested: 0,
      evicted: 0,
      lastSelection: null,
      frames: 0,
    };

    // Une taille nulle produit un drawing buffer de 1x1 : le rendu paraît
    // fonctionner et toute mesure de performance devient absurde. On ne rend
    // qu'une fois une taille réelle connue, et on la reprend au moindre
    // changement du conteneur — le `resize` de la fenêtre ne suffit pas.
    this.sized = false;
    this._observer = new ResizeObserver(() => this.resize());
    this._observer.observe(canvas.parentElement ?? canvas);
    this.resize();

    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
  }

  resize() {
    const parent = this.canvas.parentElement ?? this.canvas;
    const width = Math.floor(parent.clientWidth);
    const height = Math.floor(parent.clientHeight);
    if (width < 2 || height < 2) {
      this.sized = false;
      return;
    }
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.materials.setProjection({
      viewportHeight: this.renderer.domElement.height,
      fovRadians: (this.camera.fov * Math.PI) / 180,
    });
    this.diorama.setSize(this.renderer.domElement.width, this.renderer.domElement.height);
    this.sized = true;
  }

  /** Repart de zero sur une dalle, et cadre la camera sur son emprise. */
  setTile(tile, nodes) {
    this.clear();
    this.origin = tile.origin;
    this.addTile(tile, nodes);

    const { bounds } = tile.header;
    const [ox, oy, oz] = tile.origin;
    const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    const midZ = (bounds.minZ + bounds.maxZ) / 2 - oz;
    this.controls.target.set(
      (bounds.minX + bounds.maxX) / 2 - ox,
      (bounds.minY + bounds.maxY) / 2 - oy,
      midZ,
    );
    this.camera.position.set(span * 0.7, -span * 0.7, midZ + span * 0.55);
    this.camera.near = Math.max(span / 5000, 0.5);
    this.camera.far = span * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /**
   * Ajoute une dalle a la scene courante, sans toucher a la camera.
   * Les points doivent etre decodes dans le repere commun : c'est
   * `sceneOrigin` que le decodeur soustrait, jamais le centre propre a la
   * dalle, sinon toutes les dalles se superposeraient au meme endroit.
   */
  addTile(tile, nodes) {
    if (!this.origin) this.origin = tile.origin;
    const key = tile.url;
    if (this.tiles.has(key)) return key;
    const { header } = tile;
    this.tiles.set(key, {
      tile,
      nodes,
      localCenter: [
        header.center[0] - this.origin[0],
        header.center[1] - this.origin[1],
        header.center[2] - this.origin[2],
      ],
    });
    return key;
  }

  hasTile(url) {
    return this.tiles.has(url);
  }

  get sceneOrigin() {
    return this.origin;
  }

  /** Retire une dalle et tout ce qu'elle a mis en scene. */
  removeTile(key) {
    if (!this.tiles.has(key)) return;
    for (const uid of [...this.loaded.keys()]) {
      if (uid.startsWith(`${key}|`)) this.removeNode(uid);
    }
    for (const uid of [...this.pending]) {
      if (uid.startsWith(`${key}|`)) this.pending.delete(uid);
    }
    this.tiles.delete(key);
  }

  /** Ajoute les points d'un noeud decode, repere par son identifiant global. */
  addNode({ uid, tileKey, node }, positions, classification) {
    this.pending.delete(uid);
    if (this.loaded.has(uid)) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    // La classification reste sur 1 octet : le GPU la convertit en float à la
    // lecture, et c'est elle qui indexe la palette. Pas de tampon de couleur.
    geometry.setAttribute('classification', new THREE.BufferAttribute(classification, 1));

    const entry = this.tiles.get(tileKey);
    const spacing = entry ? entry.tile.header.spacing / 2 ** node.key.level : 0.6;
    const points = new THREE.Points(geometry, this.materials.forSize(Math.max(0.25, spacing * 0.9)));
    points.frustumCulled = false; // le tri est fait par le sélecteur, pas par Three
    points.userData.pointCount = classification.length;
    points.userData.hist = histogram(classification);
    this.group.add(points);
    this.loaded.set(uid, points);

    for (const [code, n] of points.userData.hist) {
      this.classCounts.set(code, (this.classCounts.get(code) ?? 0) + n);
    }
    this.stats.nodesInScene = this.loaded.size;
    this.stats.pointsInScene += classification.length;
  }

  /**
   * Bascule entre lecture technique et rendu maquette.
   *
   * Les deux modes lisent exactement les memes points : seuls changent le
   * nuancier, le fond et les passes de post-traitement. C'est ce qui permet de
   * comparer les deux rendus sur une scene identique, et donc de mesurer ce que
   * l'habillage apporte vraiment.
   */
  /**
   * Applique un preset : nuancier, fond, decoupe, socle et post-traitement.
   *
   * Tous les presets lisent exactement les memes points — rien n'est recharge,
   * rien n'est retouche cote donnees. C'est ce qui permet de comparer deux
   * rendus sur une scene identique, donc de mesurer ce que l'habillage apporte.
   */
  applyPreset(name) {
    const preset = getPreset(name);
    this.preset = preset;
    this.presetName = PRESETS[name] ? name : 'lecture';
    this.dioramaOn = Boolean(preset.post);

    this.materials.setPalette(preset.palette);
    this.renderer.setClearColor(preset.background, 1);
    this.diorama.background.set(preset.background);
    // Octets bruts, pas THREE.Color : celui-ci rend du lineaire et le fond
    // ressortirait beaucoup trop sombre.
    this.diorama.edlMaterial.uniforms.uBackground.value.set(
      ((preset.background >> 16) & 0xff) / 255,
      ((preset.background >> 8) & 0xff) / 255,
      (preset.background & 0xff) / 255,
    );

    // Points carres et grossis hors mode lecture : ils se joignent en surface au
    // lieu de laisser voir le fond entre eux. Ronds et espaces, chaque
    // interstice devient un trou noir sous l'ombrage de profondeur.
    this.materials.setRound(preset.round ?? true);
    this.pointScale = preset.boost ?? 1;
    this.materials.setBoost(this.pointScale);

    if (preset.diorama) this.diorama.set(preset.diorama);
    this.materials.setTint(preset.tint ?? preset.diorama?.tint ?? 0);

    this.clipShape = preset.shape ?? null;
    if (this.clipShape) {
      this.clipRadius = preset.radius ?? this.clipRadius;
      this.clipCenter = [this.controls.target.x, this.controls.target.y];
      this.materials.setClip(this.clipCenter, this.clipRadius, this.clipShape);
      this._buildPlinth();
    } else {
      this.materials.setClip(null, 0);
      this._removePlinth();
    }
  }

  /** Compatibilite : l'ancien interrupteur bascule entre deux presets. */
  setDiorama(on) {
    this.applyPreset(on ? 'maquette' : 'lecture');
  }

  /**
   * Socle du diorama : un cylindre sous le nuage, du meme rayon que la decoupe.
   *
   * C'est lui qui fait basculer la lecture de « bout de territoire » a « objet
   * pose sur une table ». Sans socle, la decoupe circulaire donne seulement un
   * nuage amoute ; avec, l'epaisseur visible sous le terrain donne l'echelle et
   * la matiere.
   */
  _buildPlinth() {
    this._removePlinth();
    const entry = this.tiles.get([...this.tiles.keys()][0]);
    if (!entry) return;
    const { bounds } = entry.tile.header;
    const oz = this.origin[2];
    const floor = bounds.minZ - oz;
    const thickness = Math.max(this.clipRadius * 0.16, 25);

    const r = this.clipRadius;
    let geometry;
    if (this.clipShape === 'square') {
      geometry = new THREE.BoxGeometry(r * 2, r * 2, thickness);
    } else {
      geometry = new THREE.CylinderGeometry(r, r, thickness, 96, 1, false);
      geometry.rotateX(Math.PI / 2); // l'axe du cylindre est Y chez Three, Z chez nous
    }
    geometry.translate(this.clipCenter[0], this.clipCenter[1], floor - thickness / 2 + 1);

    this.plinth = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ color: this.preset.plinth ?? 0xcabfa8 }),
    );
    this.plinth.frustumCulled = false;
    this.scene.add(this.plinth);
  }

  _removePlinth() {
    if (!this.plinth) return;
    this.scene.remove(this.plinth);
    this.plinth.geometry.dispose();
    this.plinth.material.dispose();
    this.plinth = null;
  }

  /**
   * Geometries que le rendu ajoute en plus des noeuds de points.
   * Le controle anti-fuite compare `renderer.info` au nombre de noeuds : sans
   * ce decompte, le socle passerait pour une fuite.
   */
  get extraGeometries() {
    // Le socle, plus le quad plein ecran du post-traitement : celui-ci reste
    // alloue une fois qu'il a servi, y compris apres retour en mode lecture.
    return (this.plinth ? 1 : 0) + (this.diorama.uploaded ? 1 : 0);
  }

  /** Demi-cote ou rayon de la decoupe, en metres. */
  setClipRadius(radius) {
    this.clipRadius = radius;
    if (this.clipShape) {
      this.materials.setClip(this.clipCenter, radius, this.clipShape);
      this._buildPlinth();
    }
  }

  /** Une seule voie de rendu, pour que tout le reste ignore le mode courant. */
  draw() {
    if (this.dioramaOn) this.diorama.render(this.scene, this.camera);
    else this.renderer.render(this.scene, this.camera);
  }

  /**
   * Grossissement des points, en multiple de la taille naturelle.
   *
   * Cette taille naturelle vaut deja l'espacement du niveau affiche : a 1, deux
   * points voisins se touchent tout juste. Au-dela on gagne une surface pleine
   * au prix du detail ; en deca le fond transparait, ce qui creuse des trous
   * noirs sous l'ombrage de profondeur.
   */
  setPointScale(factor) {
    this.pointScale = factor;
    this.materials.setBoost(factor);
  }

  /** Masque ou révèle des classes. Instantané : seule la palette change. */
  setHiddenClasses(codes) {
    this.materials.setHidden(codes);
  }

  /**
   * Points affichés par classe. À ne jamais présenter comme la composition de
   * la zone : la mesure du 07/09/2026 sur emprise identique montre que la part
   * d'une classe dépend fortement du niveau de détail chargé — la végétation
   * haute pèse 24,3 % au niveau 2 pour 16,6 % en réalité, un facteur 1,46.
   */
  visibleClassCounts() {
    return new Map(this.classCounts);
  }

  /**
   * Retire un nœud et libère ses ressources GPU. Sans `dispose`, les géométries
   * s'accumulent côté pilote sans qu'aucun compteur JavaScript ne bouge :
   * `renderer.info.memory.geometries` est le seul témoin honnête.
   */
  removeNode(id) {
    const points = this.loaded.get(id);
    if (!points) return;
    this.group.remove(points);
    points.geometry.dispose();
    // Surtout PAS de dispose sur le matériau : il est partagé entre tous les
    // nœuds de même taille de point. Le libérer ici les casserait tous d'un coup.
    for (const [code, n] of points.userData.hist) {
      const left = (this.classCounts.get(code) ?? 0) - n;
      if (left > 0) this.classCounts.set(code, left);
      else this.classCounts.delete(code);
    }
    this.loaded.delete(id);
    this.stats.pointsInScene -= points.userData.pointCount;
    this.stats.nodesInScene = this.loaded.size;
    this.stats.evicted += 1;
  }

  clear() {
    this._removePlinth();
    for (const id of [...this.loaded.keys()]) this.removeNode(id);
    this.pending.clear();
    this.classCounts.clear();
    this.stats.pointsInScene = 0;
    this.stats.nodesInScene = 0;
    this.tiles.clear();
    this.origin = null;
  }

  /** Selection courante, sur toutes les dalles en scene. */
  select() {
    if (this.tiles.size === 0) return null;

    this.matrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.matrix);

    const groups = [...this.tiles.entries()].map(([key, entry]) => ({
      key,
      nodes: entry.nodes,
      center: entry.localCenter,
      halfSize: entry.tile.header.halfSize,
      spacing: entry.tile.header.spacing,
    }));

    return selectAcross(
      groups,
      {
        position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
        fovRadians: (this.camera.fov * Math.PI) / 180,
        viewportHeight: this.renderer.domElement.height,
      },
      {
        minScreenError: this.minScreenError,
        pointBudget: this.pointBudget,
        alwaysLevels: 0,
        isVisible: (b) => {
          this.box.min.set(b.min[0], b.min[1], b.min[2]);
          this.box.max.set(b.max[0], b.max[1], b.max[2]);
          return this.frustum.intersectsBox(this.box);
        },
      },
    );
  }

  /** Confronte la sélection à la scène : retire le superflu, demande le manquant. */
  refresh({ maxRequests = 4 } = {}) {
    const selection = this.select();
    if (!selection) return null;
    this.stats.lastSelection = {
      selected: selection.selected.length,
      points: selection.totalPoints,
      rejected: selection.rejected,
      tiles: selection.groups,
    };

    const present = new Set([...this.loaded.keys(), ...this.pending]);
    const { toAdd, toRemove } = diffSelection(selection.selected, present);

    for (const id of toRemove) {
      if (this.pending.has(id)) continue; // en vol : on le laisse arriver
      this.removeNode(id);
    }

    const batch = [];
    for (const candidate of toAdd) {
      if (batch.length >= maxRequests) break;
      this.pending.add(candidate.uid);
      batch.push({ uid: candidate.uid, tileKey: candidate.groupKey, node: candidate.node });
    }
    if (batch.length > 0) {
      this.stats.requested += batch.length;
      this.onRequestNodes?.(batch);
    }
    return selection;
  }

  _loop() {
    this._raf = requestAnimationFrame(this._loop);
    if (!this.sized) return;
    this.controls.update();
    this.refresh();
    this.draw();
    this.stats.frames += 1;
  }

  /**
   * Mesure de rendu indépendante de requestAnimationFrame, qui est gelé dès que
   * l'onglet passe en arrière-plan et rapporte alors zéro image par seconde
   * alors que le rendu fonctionne.
   */
  bench(frames = 60) {
    const gl = this.renderer.getContext();
    if (gl.drawingBufferWidth < 100 || gl.drawingBufferHeight < 100) {
      return { error: `drawing buffer ${gl.drawingBufferWidth}x${gl.drawingBufferHeight} — mesure sans objet` };
    }
    // Une page qui n'est pas composée n'exécute pas vraiment ses commandes GL :
    // elles ne partent au GPU que lorsqu'on lit le tampon. Mesuré le 07/09/2026
    // sur un onglet masqué — de 0,03 à 21 ms par image selon la méthode de
    // synchronisation, et des points quatre fois plus gros rendus « plus vite »
    // que des petits. Aucune de ces valeurs ne décrit le rendu ; mieux vaut ne
    // rien annoncer qu'annoncer un chiffre flatteur et faux.
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      return {
        unreliable: true,
        reason: "page non composée (onglet masqué) : le rendu n'est pas exécuté, toute durée mesurée ici est fictive",
        points: this.stats.pointsInScene,
      };
    }
    const pixel = new Uint8Array(4);
    const axis = new THREE.Vector3(0, 0, 1);
    for (let i = 0; i < 5; i += 1) this.draw();
    const started = performance.now();
    for (let i = 0; i < frames; i += 1) {
      this.camera.position.applyAxisAngle(axis, 0.01);
      this.camera.lookAt(this.controls.target);
      this.draw();
      gl.readPixels(1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); // force la synchro
    }
    const ms = performance.now() - started;
    return {
      frames,
      msPerFrame: +(ms / frames).toFixed(2),
      fps: +((frames * 1000) / ms).toFixed(1),
      size: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      points: this.stats.pointsInScene,
    };
  }

  /** Taux de pixels non-fond : dit si la scène occupe réellement l'écran. */
  coverage() {
    const gl = this.renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    if (w < 2 || h < 2) return null;
    // Toujours sans post-traitement : le vignettage assombrit progressivement
    // les bords, donc le fond n'est plus une couleur unique et rien ne peut plus
    // en être distingué — la mesure répondrait « 100 % » quel que soit le rendu.
    // La couverture décrit la scène, pas l'habillage.
    this.renderer.render(this.scene, this.camera);
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    // Surtout pas de THREE.Color ici : depuis la gestion des espaces
    // colorimétriques, `new THREE.Color(0x080a0e).r` rend une valeur linéaire
    // (~0,002), pas 8/255. Comparée à des octets lus par readPixels, elle fait
    // passer *tous* les pixels pour peints — le taux de couverture annonce
    // alors 100 % quel que soit le rendu.
    const hex = this.preset.background;
    const br = (hex >> 16) & 0xff;
    const bg2 = (hex >> 8) & 0xff;
    const bb = hex & 0xff;
    let painted = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (Math.abs(pixels[i] - br) > 6 || Math.abs(pixels[i + 1] - bg2) > 6 || Math.abs(pixels[i + 2] - bb) > 6) {
        painted += 1;
      }
    }
    return { size: [w, h], painted, percent: +((100 * painted) / (w * h)).toFixed(1) };
  }

  memory() {
    return { ...this.renderer.info.memory, drawCalls: this.renderer.info.render.calls };
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this._observer.disconnect();
    this.clear();
    this.controls.dispose();
    this._removePlinth();
    this.diorama.dispose();
    this.materials.dispose();
    this.renderer.dispose();
  }
}
