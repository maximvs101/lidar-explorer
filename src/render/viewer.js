import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { diffSelection, selectNodes } from '../lod/selector.js';

export const CLASS_COLORS = {
  1: [0.43, 0.43, 0.45],
  2: [0.59, 0.55, 0.47],
  3: [0.47, 0.63, 0.35],
  4: [0.37, 0.57, 0.27],
  5: [0.24, 0.47, 0.22],
  6: [0.8, 0.47, 0.37],
  9: [0.27, 0.47, 0.71],
  17: [0.67, 0.67, 0.71],
  64: [0.78, 0.75, 0.43],
  66: [0.27, 0.47, 0.71],
};
const DEFAULT_COLOR = [0.35, 0.35, 0.38];

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

    this.tile = null;
    this.available = [];
    this.loaded = new Map(); // id -> THREE.Points
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
    this.sized = true;
  }

  /** Installe une dalle : vide la scène et cadre la caméra sur son emprise. */
  setTile(tile, nodes) {
    this.clear();
    this.tile = tile;
    this.available = nodes;

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

  /** Ajoute les points d'un nœud décodé. */
  addNode(node, positions, classification) {
    this.pending.delete(node.id);
    if (this.loaded.has(node.id)) return;

    const colors = new Float32Array(classification.length * 3);
    for (let i = 0; i < classification.length; i += 1) {
      const c = CLASS_COLORS[classification[i]] ?? DEFAULT_COLOR;
      colors[i * 3] = c[0];
      colors[i * 3 + 1] = c[1];
      colors[i * 3 + 2] = c[2];
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: Math.max(0.35, node.spacingAtLevel ?? 0.6),
      sizeAttenuation: true,
      vertexColors: true,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false; // le tri est fait par le sélecteur, pas par Three
    points.userData.pointCount = classification.length;
    this.group.add(points);
    this.loaded.set(node.id, points);

    this.stats.nodesInScene = this.loaded.size;
    this.stats.pointsInScene += classification.length;
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
    points.material.dispose();
    this.loaded.delete(id);
    this.stats.pointsInScene -= points.userData.pointCount;
    this.stats.nodesInScene = this.loaded.size;
    this.stats.evicted += 1;
  }

  clear() {
    for (const id of [...this.loaded.keys()]) this.removeNode(id);
    this.pending.clear();
    this.stats.pointsInScene = 0;
    this.stats.nodesInScene = 0;
    this.available = [];
  }

  /** Sélection courante, d'après la position réelle de la caméra. */
  select() {
    if (!this.tile || this.available.length === 0) return null;
    const { header, origin } = this.tile;

    this.matrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.matrix);

    const localCenter = [
      header.center[0] - origin[0],
      header.center[1] - origin[1],
      header.center[2] - origin[2],
    ];

    return selectNodes(
      this.available,
      {
        position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
        fovRadians: (this.camera.fov * Math.PI) / 180,
        viewportHeight: this.renderer.domElement.height,
      },
      {
        center: localCenter,
        halfSize: header.halfSize,
        spacing: header.spacing,
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
      this.pending.add(candidate.node.id);
      batch.push(candidate.node);
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
    this.renderer.render(this.scene, this.camera);
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
    const pixel = new Uint8Array(4);
    const axis = new THREE.Vector3(0, 0, 1);
    for (let i = 0; i < 5; i += 1) this.renderer.render(this.scene, this.camera);
    const started = performance.now();
    for (let i = 0; i < frames; i += 1) {
      this.camera.position.applyAxisAngle(axis, 0.01);
      this.camera.lookAt(this.controls.target);
      this.renderer.render(this.scene, this.camera);
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
    this.renderer.render(this.scene, this.camera);
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let painted = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (Math.abs(pixels[i] - 8) > 6 || Math.abs(pixels[i + 1] - 10) > 6 || Math.abs(pixels[i + 2] - 14) > 6) {
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
    this.renderer.dispose();
  }
}
