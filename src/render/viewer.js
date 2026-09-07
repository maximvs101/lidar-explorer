import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { diffSelection, selectAcross } from '../lod/selector.js';
import { PointsMaterialPool } from './pointsMaterial.js';
import { PRESETS, getPreset } from './presets.js';
import { ReliefRenderer } from './relief.js';
import { ScenePicker } from './picker.js';
import { histogram } from '../analysis/classStats.js';
import { TerrainGrid, heightStats } from '../analysis/terrain.js';
import { WaterPlanarity, classContradictions, summarise } from '../analysis/audit.js';

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
    this.relief = new ReliefRenderer(this.renderer);
    this.reliefOn = false;
    this.picker = new ScenePicker(this.renderer);
    this.measureGroup = new THREE.Group();
    this.measureGroup.renderOrder = 10;
    this.scene.add(this.measureGroup);
    this._measureGeometries = 0;
    this.pointScale = 1;
    // Grille de terrain : 3 km de cote en 512 cellules, soit ~5,9 m. Le sol
    // varie peu a cette echelle, et une grille plus fine ferait exploser le
    // cout du comblement, qui parcourt la grille entiere a chaque passe.
    this.terrain = null;
    this.terrainCells = 512;
    this.terrainSize = 3000;
    this.terrainStats = null;
    this._terrainBuiltAt = 0;
    this.auditStats = null;
    this._auditAt = 0;
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
    this.relief.setSize(this.renderer.domElement.width, this.renderer.domElement.height);
    this.sized = true;
  }

  /** Repart de zero sur une dalle, et cadre la camera sur son emprise. */
  setTile(tile, nodes) {
    this.clear();
    this.origin = tile.origin;
    // La grille suit le repere de scene, comme les points.
    this.terrain = new TerrainGrid({ center: [0, 0], size: this.terrainSize, cells: this.terrainCells });
    this.terrainStats = null;
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
  addNode({ uid, tileKey, node }, positions, classification, extras = {}) {
    this.pending.delete(uid);
    if (this.loaded.has(uid)) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    // La classification reste sur 1 octet : le GPU la convertit en float à la
    // lecture, et c'est elle qui indexe la palette. Pas de tampon de couleur.
    geometry.setAttribute('classification', new THREE.BufferAttribute(classification, 1));
    // Attributs facultatifs : le rendu retombe sur la couleur de classe s'ils
    // manquent, plutot que d'echouer a compiler faute d'attribut declare.
    if (extras.intensity) geometry.setAttribute('intensity', new THREE.BufferAttribute(extras.intensity, 1));
    if (extras.returns) geometry.setAttribute('returns', new THREE.BufferAttribute(extras.returns, 1));
    if (extras.source) geometry.setAttribute('source', new THREE.BufferAttribute(extras.source, 1));

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
    // Le terrain se nourrit de tout ce qui passe, y compris des noeuds qui
    // seront evinces ensuite : le sol ne bouge pas, autant le garder.
    this.terrain?.addPoints(positions, classification);
    this.stats.nodesInScene = this.loaded.size;
    this.stats.pointsInScene += classification.length;
  }

  /**
   * Fige le terrain et le publie au rendu.
   *
   * Le comblement des trous parcourt la grille entiere a chaque passe, donc on
   * ne le refait pas a chaque noeud recu : un intervalle minimal suffit, le sol
   * n'ayant aucune raison de changer entre deux images.
   */
  buildTerrain({ minInterval = 700, force = false } = {}) {
    if (!this.terrain) return null;
    const maintenant = performance.now();
    if (!force && this.terrain.filled) return this.terrainStats;
    if (!force && maintenant - this._terrainBuiltAt < minInterval) return this.terrainStats;

    const bilan = this.terrain.build();
    this._terrainBuiltAt = maintenant;
    this.materials.setTerrain(this.terrain);
    if (this.preset.heightMax) this.materials.setHeightScale(this.preset.heightMax);
    this.terrainStats = {
      ...bilan,
      coverage: this.terrain.coverage(),
      cells: this.terrain.cells,
      step: this.terrain.step,
    };
    return this.terrainStats;
  }

  /**
   * Passe d'audit sur tout ce qui est en scene.
   *
   * Le parcours est en O(points) : quelques millions de points a chaque appel,
   * donc un intervalle minimal, et seulement quand le mode est actif.
   */
  runAudit({ minInterval = 2500, force = false } = {}) {
    if (!this.terrain || !this.terrain.filled) return null;
    const maintenant = performance.now();
    if (!force && maintenant - this._auditAt < minInterval) return this.auditStats;

    const contradictions = {
      vegetationTropBasse: 0, batimentSousSol: 0, solEnLair: 0, testes: 0, sansSol: 0,
    };
    const eau = new WaterPlanarity({ cell: 20 });
    for (const points of this.loaded.values()) {
      const pos = points.geometry.getAttribute('position').array;
      const cls = points.geometry.getAttribute('classification').array;
      classContradictions(this.terrain, pos, cls, contradictions);
      eau.addPoints(pos, cls);
    }
    this._auditAt = maintenant;
    this.auditStats = summarise(contradictions, eau.report());
    return this.auditStats;
  }

  /**
   * Regle les bornes d'intensite sur les centiles de ce qui est charge.
   *
   * Une plage fixe ne vaudrait que pour la zone ou elle a ete mesuree : la
   * reflectance depend du capteur, de la hauteur de vol et des materiaux. On
   * borne sur les centiles 2 et 98 plutot que sur le min et le max, qu'un seul
   * echo aberrant suffirait a etirer jusqu'a aplatir tout le reste.
   */
  autoIntensityRange({ sample = 40000 } = {}) {
    const valeurs = [];
    for (const points of this.loaded.values()) {
      const attr = points.geometry.getAttribute('intensity');
      if (!attr) continue;
      const a = attr.array;
      const pas = Math.max(1, Math.floor(a.length / (sample / Math.max(this.loaded.size, 1))));
      for (let i = 0; i < a.length; i += pas) valeurs.push(a[i]);
    }
    if (valeurs.length < 50) return null;
    valeurs.sort((x, y) => x - y);
    const at = (f) => valeurs[Math.min(valeurs.length - 1, Math.floor(f * valeurs.length))];
    const bas = at(0.02);
    const haut = at(0.98);
    if (!(haut > bas)) return null;
    this.materials.setIntensityRange(bas, haut);
    return { low: bas, high: haut, sampled: valeurs.length };
  }

  /** Statistiques de hauteur de la vegetation actuellement en scene. */
  canopyStats(codes = new Set([3, 4, 5])) {
    if (!this.terrain || !this.terrain.filled) return null;
    let total = 0;
    let inconnus = 0;
    const hauteurs = [];
    for (const points of this.loaded.values()) {
      const pos = points.geometry.getAttribute('position').array;
      const cls = points.geometry.getAttribute('classification').array;
      const s = heightStats(this.terrain, pos, cls, codes);
      if (s.count === 0 && s.unknown === 0) continue;
      total += s.count;
      inconnus += s.unknown;
      if (Number.isFinite(s.p99)) hauteurs.push(s.p99);
      if (Number.isFinite(s.max)) hauteurs.push(s.max);
    }
    if (hauteurs.length === 0) return { count: total, unknown: inconnus, max: NaN, p99: NaN };
    hauteurs.sort((a, b) => a - b);
    return {
      count: total,
      unknown: inconnus,
      max: hauteurs[hauteurs.length - 1],
      p99: hauteurs[Math.floor(hauteurs.length * 0.5)],
    };
  }

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
    this.reliefOn = Boolean(preset.post);

    this.materials.setPalette(preset.palette);
    this.renderer.setClearColor(preset.background, 1);
    
    this.relief.setBackground(preset.background);

    // Taille et forme des points ne sont PAS touchees ici : ce sont des
    // preferences d'affichage, pas des attributs de style. Les ecraser a chaque
    // changement de preset obligerait a les regler de nouveau juste pour
    // comparer deux rendus — or comparer est precisement l'usage des presets.
    // Un preset peut malgre tout les imposer en les declarant explicitement.
    if (preset.round !== undefined) this.materials.setRound(preset.round);
    if (preset.boost !== undefined) {
      this.pointScale = preset.boost;
      this.materials.setBoost(this.pointScale);
    }

    if (preset.relief) this.relief.set(preset.relief);

    // La couleur par hauteur remplace la couleur par classe ; sans terrain
    // pret, on n'active rien plutot que de peindre du gris partout.
    // Un seul aiguillage : le preset nomme sa source de couleur.
    const mode = preset.colorMode ?? (preset.heightMode ? 'hauteur' : preset.auditMode ? 'audit' : 'classe');
    this.materials.setHeightScale(preset.heightMax ?? 30);
    if (mode === 'hauteur' || mode === 'audit') this.buildTerrain({ force: true });
    this.materials.setColorMode(mode);
    if (mode === 'audit') this.runAudit({ force: true });
    if (mode === 'intensite') this.autoIntensityRange();

  }


  /**
   * Geometries que le rendu ajoute en plus des noeuds de points.
   *
   * `renderer.info` compte ce qui est alloue sur le GPU, pas ce qui vient
   * d'etre dessine : le quad plein ecran y reste une fois qu'il a servi, et les
   * marqueurs de mesure tant qu'ils sont poses. Sans ce decompte, le controle
   * anti-fuite crierait a tort.
   *
   * Three partage une meme geometrie entre tous ses quads plein ecran, d'ou le
   * `||` : relief et selection n'en comptent qu'une a eux deux.
   */
  get extraGeometries() {
    return (this.relief.uploaded || this.picker.uploaded ? 1 : 0) + this._measureGeometries;
  }

  /**
   * Position 3D sous un point de l'ecran, en coordonnees de scene.
   *
   * Les coordonnees arrivent en pixels CSS ; le tampon de rendu peut avoir une
   * densite differente, d'ou la remise a l'echelle. Sans elle, la mesure serait
   * juste sur un ecran classique et decalee d'un facteur deux sur un ecran
   * dense — le genre d'erreur qui ne se voit que sur une autre machine.
   */
  pickAt(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const x = ((clientX - rect.left) / rect.width) * size.x;
    const y = ((clientY - rect.top) / rect.height) * size.y;
    if (x < 0 || y < 0 || x >= size.x || y >= size.y) return null;
    return this.picker.pick(this.scene, this.camera, x, y);
  }

  /** Pose les marqueurs de mesure : un point, ou un segment entre deux points. */
  showMeasure(points) {
    this.clearMeasure();
    if (!points || points.length === 0) return;

    const sphere = new THREE.SphereGeometry(1, 16, 12);
    this._measureGeometries += 1;
    // Le rayon suit la distance a la camera : un marqueur de taille fixe dans
    // le monde disparait de loin et devient enorme de pres.
    const echelle = Math.max(this.camera.position.distanceTo(this.controls.target) * 0.006, 0.4);
    const matiere = new THREE.MeshBasicMaterial({ color: 0xff5b4a, depthTest: false });
    for (const p of points) {
      const m = new THREE.Mesh(sphere, matiere);
      m.position.copy(p);
      m.scale.setScalar(echelle);
      m.renderOrder = 11;
      this.measureGroup.add(m);
    }

    if (points.length >= 2) {
      const ligne = new THREE.BufferGeometry().setFromPoints([points[0], points[1]]);
      this._measureGeometries += 1;
      const trait = new THREE.Line(
        ligne,
        new THREE.LineBasicMaterial({ color: 0xff5b4a, depthTest: false }),
      );
      trait.renderOrder = 11;
      this.measureGroup.add(trait);
    }
  }

  clearMeasure() {
    for (const enfant of [...this.measureGroup.children]) {
      this.measureGroup.remove(enfant);
      enfant.geometry?.dispose();
      enfant.material?.dispose();
    }
    this._measureGeometries = 0;
  }


  /** Une seule voie de rendu, pour que tout le reste ignore le mode courant. */
  draw() {
    if (this.reliefOn) this.relief.render(this.scene, this.camera);
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
  /**
   * Seuil de raffinement, en pixels d'erreur a l'ecran.
   *
   * C'est le vrai levier de precision : sous ce seuil, raffiner n'apporterait
   * plus rien de visible et le selecteur s'arrete. L'abaisser fait descendre
   * plus bas dans l'octree — plus de points, plus fins — au prix du reseau et de
   * la memoire. Grossir les points, a l'inverse, ne fait qu'effacer la
   * resolution deja chargee.
   */
  setDetail(pixels) {
    this.minScreenError = pixels;
  }

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
    this.clearMeasure();
        this.terrain = null;
    this.terrainStats = null;
    this.auditStats = null;
    this.materials.setTerrain(null);
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
    // Le terrain se refige quand de nouveaux points de sol sont arrives ; la
    // methode porte son propre intervalle minimal, l'appeler a chaque image ne
    // coute donc rien la plupart du temps.
    // Les deux modes qui reposent sur le terrain le maintiennent a jour ;
    // buildTerrain et runAudit portent chacun leur intervalle minimal.
    const modeCourant = this.materials.shared.uColorMode;
    if (modeCourant === 1 || modeCourant === 2) this.buildTerrain();
    if (modeCourant === 2) this.runAudit();

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
   * Rend une image a une resolution superieure a celle de l'ecran.
   *
   * Le piege : plusieurs effets sont exprimes **en texels**, pas en metres.
   * Doubler la resolution sans y toucher divise par deux leur portee relative —
   * l'ombrage cesse de creuser, le flou de bord disparait — et l'image exportee
   * ne ressemble plus a ce qu'on voyait. On met donc leur rayon a l'echelle du
   * facteur d'agrandissement, puis on restaure tout.
   */
  async capture({ scale = 2, type = 'image/png' } = {}) {
    const canvas = this.renderer.domElement;
    const largeur = canvas.width;
    const hauteur = canvas.height;
    if (largeur < 2 || hauteur < 2) throw new Error('vue non dimensionnee');

    const cible = { w: Math.round(largeur * scale), h: Math.round(hauteur * scale) };
    const ratioPixel = this.renderer.getPixelRatio();
    const reglages = { ...this.relief.settings };

    try {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(cible.w, cible.h, false);
      this.camera.aspect = cible.w / cible.h;
      this.camera.updateProjectionMatrix();
      this.materials.setProjection({
        viewportHeight: cible.h,
        fovRadians: (this.camera.fov * Math.PI) / 180,
      });
      this.relief.setSize(cible.w, cible.h);
      this.relief.set({
        radius: reglages.radius * scale,
        lightSpread: reglages.lightSpread * scale,
      });

      this.draw();
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('capture vide'))), type);
      });
      return { blob, width: cible.w, height: cible.h };
    } finally {
      this.relief.set(reglages);
      this.renderer.setPixelRatio(ratioPixel);
      this.resize();
      this.draw();
    }
  }

  /** Nom de fichier lisible : lieu, style, date. */
  captureName(extension = 'png') {
    const premiere = [...this.tiles.values()][0];
    const nom = premiere?.tile?.header ? (premiere.tile.url.match(/LHD_FXX_(\d{4}_\d{4})/)?.[1] ?? 'lidar') : 'lidar';
    const jour = new Date().toISOString().slice(0, 10);
    return `lidar-hd_${nom}_${this.presetName}_${jour}.${extension}`;
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
    this.clearMeasure();
    this.picker.dispose();
    this.relief.dispose();
    this.materials.dispose();
    this.renderer.dispose();
  }
}
