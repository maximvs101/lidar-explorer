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
 * qui n'avaient aucun sens (hauteur ET intensite).
 */
export const COLOR_MODES = {
  classe: 0,
  hauteur: 1,
  intensite: 2,
  retours: 3,
  bande: 4,
};

/**
 * Test d'egalite du mode, injecte dans le shader depuis la table ci-dessus.
 *
 * GLSL n'a pas d'entier ici : le mode voyage en float, et la comparaison passe
 * donc par une distance. Ce qui compte est que les seuils ne soient ecrits
 * qu'une fois : ils l'ont ete a la main, et retirer un mode du milieu de la
 * table decalait tous les suivants sans que rien ne le signale — chaque mode
 * affichait alors celui d'a cote.
 */
const estMode = (nom) => `abs(uColorMode - ${COLOR_MODES[nom].toFixed(1)}) < 0.5`;

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
  uniform float uHeightMax;
  uniform float uColorMode;
  uniform vec2 uIntensityRange;
  uniform vec2 uHeightRange;
  uniform float uHeightFilter;
  uniform vec4 uSection;
  uniform float uSectionWidth;
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
    if (${estMode('intensite')}) {
      float t = clamp((intensity - uIntensityRange.x)
                      / max(uIntensityRange.y - uIntensityRange.x, 1.0), 0.0, 1.0);
      vColor = mix(vec3(0.13, 0.13, 0.15), vec3(0.97, 0.95, 0.88), t);
    }

    // --- Retours : le nombre total d'echos du tir, sur les 4 bits hauts. Un tir
    // qui en renvoie plusieurs a traverse quelque chose — c'est la signature du
    // feuillage, et ce que le lidar a d'irremplacable.
    if (${estMode('retours')}) {
      float total = floor(returns / 16.0);
      if (total <= 1.5)      vColor = vec3(0.72, 0.71, 0.68);
      else if (total <= 2.5) vColor = vec3(0.85, 0.78, 0.35);
      else if (total <= 3.5) vColor = vec3(0.90, 0.55, 0.25);
      else                   vColor = vec3(0.85, 0.25, 0.25);
    }

    // --- Bande de vol : montre le plan de vol et les recouvrements entre passes.
    if (${estMode('bande')}) {
      vColor = teinteQualitative(source);
    }

    if (${estMode('hauteur')}) {
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
    // --- Filtres. Un point ecarte est renvoye hors du volume de vue : rien
    // n'est rasterise, ce qui coute moins qu'un discard au fragment.
    bool garde = entry.a >= 0.5;

    // Hauteur au-dessus du sol. La ou le terrain est inconnu, le point est
    // ecarte : le filtre garde ce qu'il peut prouver dans la plage, il ne
    // laisse pas passer ce qu'il ne sait pas juger.
    if (garde && uHeightFilter > 0.5) {
      vec2 uvh = (position.xy - uTerrainMin) / uTerrainSize;
      if (uvh.x < 0.0 || uvh.x > 1.0 || uvh.y < 0.0 || uvh.y > 1.0) garde = false;
      else {
        float solF = texture2D(uTerrain, uvh).r;
        if (solF < -9000.0) garde = false;
        else {
          float hf = position.z - solF;
          if (hf < uHeightRange.x || hf > uHeightRange.y) garde = false;
        }
      }
    }

    // Coupe : bande de largeur uSectionWidth autour du segment, en plan.
    // La projection est bornee au segment, donc la bande a des bouts arrondis
    // plutot que de s'etendre a l'infini le long de la droite porteuse.
    if (garde && uSectionWidth > 0.0) {
      vec2 pa = position.xy - uSection.xy;
      vec2 ba = uSection.zw - uSection.xy;
      float t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
      if (length(pa - ba * t) > uSectionWidth * 0.5) garde = false;
    }

    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uAttenuate > 0.5 ? max(1.0, uBoost * uSize * uScale / max(-mv.z, 0.001)) : uSize * uBoost;
    if (!garde) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
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
      uHeightMax: 30, uColorMode: 0,
      uIntensityRange: [200, 1450],
      // Plage de hauteur au-dessus du sol, et bande de coupe. Toutes deux
      // inertes tant qu'on ne les allume pas : une largeur nulle ne coupe rien,
      // et le filtre de hauteur porte son propre interrupteur parce qu'une
      // plage « de 0 a l'infini » resterait un filtre actif, qui ecarterait les
      // points sans sol connu.
      uHeightRange: [0, 60], uHeightFilter: 0,
      uSection: [0, 0, 0, 0], uSectionWidth: 0,
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
        uHeightMax: { value: this.shared.uHeightMax },
        uColorMode: { value: this.shared.uColorMode },
        uIntensityRange: { value: new THREE.Vector2(...this.shared.uIntensityRange) },
        uHeightRange: { value: new THREE.Vector2(...this.shared.uHeightRange) },
        uHeightFilter: { value: this.shared.uHeightFilter },
        uSection: { value: new THREE.Vector4(...this.shared.uSection) },
        uSectionWidth: { value: this.shared.uSectionWidth },
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

  /**
   * Ne montre que ce qui se tient entre deux hauteurs au-dessus du sol.
   *
   * Sans terrain publie, le filtre ecarterait tout : on refuse alors de
   * l'activer plutot que de vider la scene sans explication. L'appelant lit la
   * valeur rendue pour savoir ce qui s'est reellement passe.
   */
  setHeightFilter(min, max, active = true) {
    const possible = active && Boolean(this.terrainTexture)
      && Number.isFinite(min) && Number.isFinite(max);
    this.shared.uHeightFilter = possible ? 1 : 0;
    if (possible) this.shared.uHeightRange = [Math.min(min, max), Math.max(min, max)];
    this._pushShared();
    return this.shared.uHeightFilter === 1;
  }

  /**
   * Ne montre qu'une bande autour d'un segment, en plan.
   *
   * Une largeur nulle ou negative eteint la coupe : c'est le seul etat qui
   * n'ecarte rien, et il vaut mieux qu'un interrupteur de plus.
   */
  setSection(a, b, width) {
    const actif = Boolean(a) && Boolean(b) && Number.isFinite(width) && width > 0;
    this.shared.uSectionWidth = actif ? width : 0;
    if (actif) this.shared.uSection = [a[0], a[1], b[0], b[1]];
    this._pushShared();
    return this.shared.uSectionWidth > 0;
  }

  /** Borne haute de la rampe de hauteur, en metres. Le mode vient de setColorMode. */
  setHeightScale(maxHeight) {
    this.shared.uHeightMax = maxHeight;
    this._pushShared();
  }

  /**
   * Choisit la source de couleur. Les modes qui reposent sur le terrain
   * (hauteur) reste inactif tant qu'il n'est pas pret : mieux vaut la
   * couleur de classe qu'un gris uniforme sans explication.
   */
  setColorMode(mode) {
    const code = COLOR_MODES[mode] ?? COLOR_MODES.classe;
    const besoinTerrain = code === COLOR_MODES.hauteur;
    if (besoinTerrain && !this.terrainTexture) {
      this.shared.uColorMode = COLOR_MODES.classe;
    } else {
      this.shared.uColorMode = code;
    }
    this._pushShared();
  }

  /** Bornes d'intensite, en unites brutes du capteur. */
  setIntensityRange(low, high) {
    this.shared.uIntensityRange = [low, high];
    this._pushShared();
  }

  _pushShared() {
    for (const material of this.materials.values()) {
      material.uniforms.uScale.value = this.shared.uScale;
      material.uniforms.uAttenuate.value = this.shared.uAttenuate;
      material.uniforms.uRound.value = this.shared.uRound;
      material.uniforms.uBoost.value = this.shared.uBoost;
      material.uniforms.uHeightMax.value = this.shared.uHeightMax;
      material.uniforms.uColorMode.value = this.shared.uColorMode;
      material.uniforms.uIntensityRange.value.set(
        this.shared.uIntensityRange[0], this.shared.uIntensityRange[1],
      );
      material.uniforms.uHeightRange.value.set(
        this.shared.uHeightRange[0], this.shared.uHeightRange[1],
      );
      material.uniforms.uHeightFilter.value = this.shared.uHeightFilter;
      material.uniforms.uSection.value.set(...this.shared.uSection);
      material.uniforms.uSectionWidth.value = this.shared.uSectionWidth;
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
