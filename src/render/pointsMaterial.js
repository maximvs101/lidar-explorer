import * as THREE from 'three';

/**
 * Palette et filtrage des classes, côté GPU.
 *
 * La classification reste un attribut de 1 octet par point ; couleur et
 * visibilité sont lues dans une texture de 256 entrées indexée par le code de
 * classe. Changer une couleur ou masquer une classe ne coûte alors qu'une
 * écriture de 256 pixels, au lieu de reconstruire les tampons de couleur de
 * plusieurs millions de points.
 */

export const DEFAULT_PALETTE = {
  1: [110, 110, 115],
  2: [150, 140, 120],
  3: [120, 160, 90],
  4: [95, 145, 70],
  5: [60, 120, 55],
  6: [205, 120, 95],
  9: [70, 120, 180],
  17: [170, 170, 180],
  64: [200, 190, 110],
  65: [150, 90, 150],
  66: [70, 120, 180],
  67: [130, 130, 135],
};
/**
 * Palette neutre, pour les modes d'analyse.
 *
 * Le nuancier de classification est fait pour distinguer les classes ; il sature
 * l'image dès qu'on veut lire autre chose. Celui-ci reste discret sur fond clair
 * pour que l'information vienne d'ailleurs — hauteur, retours, ombrage de
 * profondeur — sans que la couleur de classe entre en concurrence avec elle.
 */
export const NEUTRAL_PALETTE = {
  1: [176, 170, 160],
  2: [214, 198, 172],
  3: [156, 178, 124],
  4: [126, 158, 104],
  5: [96, 134, 88],
  6: [234, 220, 200],
  9: [126, 172, 186],
  17: [196, 190, 180],
  64: [216, 196, 148],
  65: [178, 150, 176],
  66: [126, 172, 186],
  67: [186, 182, 176],
};

const FALLBACK = [90, 90, 95];

/**
 * Modes de coloration. Un seul uniforme les porte tous : trois interrupteurs
 * separes finissaient par s'empiler en cascade de `if`, avec des combinaisons
 * qui n'avaient aucun sens (hauteur ET audit ET intensite).
 */
export const COLOR_MODES = {
  classe: 0,
  hauteur: 1,
  audit: 2,
  intensite: 3,
  retours: 4,
  bande: 5,
};

const VERTEX = /* glsl */ `
  attribute float classification;
  attribute float intensity;
  attribute float returns;
  attribute float source;
  uniform sampler2D uPalette;
  uniform float uSize;
  uniform float uScale;
  uniform float uAttenuate;
  uniform float uBoost;
  uniform sampler2D uTerrain;
  uniform vec2 uTerrainMin;
  uniform float uTerrainSize;
  uniform float uHeightMode;
  uniform float uHeightMax;
  uniform float uAuditMode;
  uniform float uColorMode;
  uniform vec2 uIntensityRange;
  varying vec3 vColor;

  // Rampe de hauteur : du sol nu aux emergents. Le brun de depart evite de
  // confondre un point au ras du sol avec un buisson.
  vec3 rampeHauteur(float t) {
    vec3 c;
    if (t < 0.10)      c = mix(vec3(0.58, 0.53, 0.45), vec3(0.76, 0.78, 0.42), t / 0.10);
    else if (t < 0.30) c = mix(vec3(0.76, 0.78, 0.42), vec3(0.44, 0.68, 0.35), (t - 0.10) / 0.20);
    else if (t < 0.60) c = mix(vec3(0.44, 0.68, 0.35), vec3(0.18, 0.47, 0.28), (t - 0.30) / 0.30);
    else               c = mix(vec3(0.18, 0.47, 0.28), vec3(0.95, 0.88, 0.55), (t - 0.60) / 0.40);
    return c;
  }

  /**
   * Teinte qualitative tiree d'un identifiant.
   *
   * Pour une bande de vol, il n'y a pas d'ordre a respecter : il faut seulement
   * que deux bandes voisines se distinguent. Le nombre d'or fait tourner la
   * teinte d'un pas qui ne retombe jamais sur lui-meme.
   */
  vec3 teinteQualitative(float id) {
    float h = fract(id * 0.6180339887);
    vec3 k = fract(vec3(h) + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0));
    vec3 rgb = clamp(abs(k * 6.0 - 3.0) - 1.0, 0.0, 1.0);
    return mix(vec3(0.55), rgb, 0.72); // desature : on veut distinguer, pas eblouir
  }


  void main() {
    vec4 entry = texture2D(uPalette, vec2((classification + 0.5) / 256.0, 0.5));
    vColor = entry.rgb;

    // --- Intensite : mesure physique, donc echelle neutre. Elle est bornee sur
    // des centiles et non sur le min/max, qu'un seul echo aberrant suffirait a
    // etirer jusqu'a aplatir tout le reste.
    if (uColorMode > 2.5 && uColorMode < 3.5) {
      float t = clamp((intensity - uIntensityRange.x)
                      / max(uIntensityRange.y - uIntensityRange.x, 1.0), 0.0, 1.0);
      vColor = mix(vec3(0.13, 0.13, 0.15), vec3(0.97, 0.95, 0.88), t);
    }

    // --- Retours : le nombre total d'echos du tir, sur les 4 bits hauts. Un tir
    // qui en renvoie plusieurs a traverse quelque chose — c'est la signature du
    // feuillage, et ce que le lidar a d'irremplacable.
    if (uColorMode > 3.5 && uColorMode < 4.5) {
      float total = floor(returns / 16.0);
      if (total <= 1.5)      vColor = vec3(0.72, 0.71, 0.68);
      else if (total <= 2.5) vColor = vec3(0.85, 0.78, 0.35);
      else if (total <= 3.5) vColor = vec3(0.90, 0.55, 0.25);
      else                   vColor = vec3(0.85, 0.25, 0.25);
    }

    // --- Bande de vol : montre le plan de vol et les recouvrements entre passes.
    if (uColorMode > 4.5) {
      vColor = teinteQualitative(source);
    }

    // Mode audit : on ne peint en rouge que les points qui contredisent la
    // definition de leur propre classe, et seulement la ou le sol est connu.
    // Ailleurs, le gris dit « rien a redire », pas « verifie ».
    if (uAuditMode > 0.5) {
      vec2 uva = (position.xy - uTerrainMin) / uTerrainSize;
      vec3 neutre = vec3(0.72, 0.71, 0.68);
      if (uva.x < 0.0 || uva.x > 1.0 || uva.y < 0.0 || uva.y > 1.0) {
        vColor = vec3(0.55, 0.55, 0.58);
      } else {
        float solA = texture2D(uTerrain, uva).r;
        if (solA < -9000.0) {
          vColor = vec3(0.55, 0.55, 0.58); // sol inconnu : non jugeable
        } else {
          float ha = position.z - solA;
          vColor = neutre;
          // Vegetation haute (5) sous 1 m : contredit sa strate.
          if (abs(classification - 5.0) < 0.5 && ha < 1.0) vColor = vec3(0.90, 0.24, 0.24);
          // Batiment (6) a plus d'un metre sous le terrain.
          if (abs(classification - 6.0) < 0.5 && ha < -1.0) vColor = vec3(0.85, 0.30, 0.75);
        }
      }
    }

    if (uHeightMode > 0.5) {
      vec2 uv = (position.xy - uTerrainMin) / uTerrainSize;
      // Hors de la grille, l'echantillonnage rendrait le bord sans rien dire :
      // on le detecte explicitement plutot que de peindre une hauteur inventee.
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        vColor = vec3(0.42, 0.42, 0.45);
      } else {
        float sol = texture2D(uTerrain, uv).r;
        if (sol < -9000.0) {
          vColor = vec3(0.42, 0.42, 0.45); // terrain non observe et non comble
        } else {
          vColor = rampeHauteur(clamp((position.z - sol) / uHeightMax, 0.0, 1.0));
        }
      }
    }
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uAttenuate > 0.5 ? max(1.0, uBoost * uSize * uScale / max(-mv.z, 0.001)) : uSize * uBoost;
    // Une classe masquée est renvoyée hors du volume de vue : rien n'est
    // rasterisé, ce qui coûte moins qu'un discard au fragment.
    if (entry.a < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform float uRound;
  varying vec3 vColor;

  void main() {
    if (uRound > 0.5) {
      vec2 d = gl_PointCoord - vec2(0.5);
      if (dot(d, d) > 0.25) discard;
    }
    gl_FragColor = vec4(vColor, 1.0);
  }
`;

export class PointsMaterialPool {
  constructor({ palette = DEFAULT_PALETTE, round = true, attenuate = true } = {}) {
    this.palette = { ...palette };
    this.hidden = new Set();
    this.texture = this._buildTexture();
    this.terrainTexture = null;
    this.terrainMin = [0, 0];
    this.terrainSize = 1;
    this.materials = new Map(); // taille de point -> ShaderMaterial
    this.shared = {
      uScale: 1, uAttenuate: attenuate ? 1 : 0, uRound: round ? 1 : 0, uBoost: 1,
      uHeightMode: 0, uHeightMax: 30, uAuditMode: 0, uColorMode: 0,
      uIntensityRange: [200, 1450],
    };
  }

  _buildTexture() {
    const data = new Uint8Array(256 * 4);
    const texture = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    this._fill(data);
    texture.needsUpdate = true;
    return texture;
  }

  _fill(data = this.texture.image.data) {
    for (let code = 0; code < 256; code += 1) {
      const rgb = this.palette[code] ?? FALLBACK;
      const o = code * 4;
      data[o] = rgb[0];
      data[o + 1] = rgb[1];
      data[o + 2] = rgb[2];
      data[o + 3] = this.hidden.has(code) ? 0 : 255;
    }
  }

  /** Applique un jeu de classes masquées. Effet immédiat, sans retoucher aux points. */
  setHidden(codes) {
    this.hidden = new Set(codes);
    this._fill();
    this.texture.needsUpdate = true;
  }

  /** Change de nuancier sans toucher aux points : seule la texture est réécrite. */
  setPalette(palette) {
    this.palette = { ...palette };
    this._fill();
    this.texture.needsUpdate = true;
  }

  isHidden(code) {
    return this.hidden.has(code);
  }

  /** Matériau pour une taille de point donnée ; un seul par taille distincte. */
  forSize(size) {
    const key = size.toFixed(3);
    let material = this.materials.get(key);
    if (material) return material;

    material = new THREE.ShaderMaterial({
      uniforms: {
        uPalette: { value: this.texture },
        uSize: { value: size },
        uScale: { value: this.shared.uScale },
        uAttenuate: { value: this.shared.uAttenuate },
        uRound: { value: this.shared.uRound },
        uBoost: { value: this.shared.uBoost },
        uTerrain: { value: this.terrainTexture },
        uTerrainMin: { value: new THREE.Vector2(0, 0) },
        uTerrainSize: { value: 1 },
        uHeightMode: { value: this.shared.uHeightMode },
        uHeightMax: { value: this.shared.uHeightMax },
        uAuditMode: { value: this.shared.uAuditMode },
        uColorMode: { value: this.shared.uColorMode },
        uIntensityRange: { value: new THREE.Vector2(...this.shared.uIntensityRange) },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
    });
    this.materials.set(key, material);
    return material;
  }

  /**
   * `uScale` traduit la taille d'un point du monde vers l'écran ; il dépend de
   * la hauteur du tampon de rendu et du champ de vision, donc il change à chaque
   * redimensionnement.
   */
  setProjection({ viewportHeight, fovRadians }) {
    this.shared.uScale = viewportHeight / (2 * Math.tan(fovRadians / 2));
    this._pushShared();
  }

  setRound(on) {
    this.shared.uRound = on ? 1 : 0;
    this._pushShared();
  }

  setAttenuate(on) {
    this.shared.uAttenuate = on ? 1 : 0;
    this._pushShared();
  }

  /**
   * Grossit les points sans toucher aux donnees.
   *
   * En mode maquette c'est indispensable : des points espaces laissent voir le
   * fond entre eux, et l'eclairage de profondeur transforme alors chaque
   * interstice en trou noir — le rendu vire au terrain aride au lieu de la
   * surface pleine qu'on cherche.
   */
  setBoost(factor) {
    this.shared.uBoost = factor;
    this._pushShared();
  }


  /**
   * Installe le modele de terrain servant au calcul des hauteurs.
   *
   * L'altitude du sol vit dans une texture a un canal, echantillonnee au plus
   * proche : a trois metres par texel, le sol varie de quelques centimetres
   * d'une cellule a l'autre, et un filtrage lineaire n'apporterait rien qu'une
   * dependance a une extension WebGL qui n'est pas garantie.
   */
  setTerrain(grid) {
    if (this.terrainTexture) this.terrainTexture.dispose();
    if (!grid) {
      this.terrainTexture = null;
      this.shared.uHeightMode = 0;
      this._pushShared();
      return;
    }
    const data = new Float32Array(grid.height.length);
    for (let k = 0; k < data.length; k += 1) {
      data[k] = grid.known[k] ? grid.height[k] : -9999;
    }
    const texture = new THREE.DataTexture(data, grid.cells, grid.cells, THREE.RedFormat, THREE.FloatType);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    this.terrainTexture = texture;
    this.terrainMin = [grid.minX, grid.minY];
    this.terrainSize = grid.size;
    for (const material of this.materials.values()) {
      material.uniforms.uTerrain.value = texture;
      material.uniforms.uTerrainMin.value.set(grid.minX, grid.minY);
      material.uniforms.uTerrainSize.value = grid.size;
    }
  }

  /** Colore par hauteur au-dessus du sol plutot que par classe. */
  setHeightMode(on, maxHeight = 30) {
    this.shared.uHeightMode = on && this.terrainTexture ? 1 : 0;
    this.shared.uHeightMax = maxHeight;
    this._pushShared();
  }

  /**
   * Choisit la source de couleur. Les modes qui reposent sur le terrain
   * (hauteur, audit) restent inactifs tant qu'il n'est pas pret : mieux vaut la
   * couleur de classe qu'un gris uniforme sans explication.
   */
  setColorMode(mode) {
    const code = COLOR_MODES[mode] ?? COLOR_MODES.classe;
    const besoinTerrain = code === COLOR_MODES.hauteur || code === COLOR_MODES.audit;
    if (besoinTerrain && !this.terrainTexture) {
      this.shared.uColorMode = COLOR_MODES.classe;
    } else {
      this.shared.uColorMode = code;
    }
    this.shared.uHeightMode = this.shared.uColorMode === COLOR_MODES.hauteur ? 1 : 0;
    this.shared.uAuditMode = this.shared.uColorMode === COLOR_MODES.audit ? 1 : 0;
    this._pushShared();
  }

  /** Bornes d'intensite, en unites brutes du capteur. */
  setIntensityRange(low, high) {
    this.shared.uIntensityRange = [low, high];
    this._pushShared();
  }

  /** Colore en rouge les points qui contredisent la definition de leur classe. */
  setAuditMode(on) {
    this.shared.uAuditMode = on && this.terrainTexture ? 1 : 0;
    this._pushShared();
  }


  _pushShared() {
    for (const material of this.materials.values()) {
      material.uniforms.uScale.value = this.shared.uScale;
      material.uniforms.uAttenuate.value = this.shared.uAttenuate;
      material.uniforms.uRound.value = this.shared.uRound;
      material.uniforms.uBoost.value = this.shared.uBoost;
      material.uniforms.uHeightMode.value = this.shared.uHeightMode;
      material.uniforms.uHeightMax.value = this.shared.uHeightMax;
      material.uniforms.uAuditMode.value = this.shared.uAuditMode;
      material.uniforms.uColorMode.value = this.shared.uColorMode;
      material.uniforms.uIntensityRange.value.set(
        this.shared.uIntensityRange[0], this.shared.uIntensityRange[1],
      );
      if (this.terrainTexture) {
        material.uniforms.uTerrain.value = this.terrainTexture;
        material.uniforms.uTerrainMin.value.set(this.terrainMin[0], this.terrainMin[1]);
        material.uniforms.uTerrainSize.value = this.terrainSize;
      }
    }
  }

  dispose() {
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
    this.texture.dispose();
    this.terrainTexture?.dispose();
  }
}
