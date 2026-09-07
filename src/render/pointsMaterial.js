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
 * Palette « maquette » : des matières plutôt que des codes.
 *
 * Le nuancier de classification est fait pour distinguer, pas pour être beau —
 * ses couleurs saturées sur fond noir donnent un rendu d'instrument. Ici on vise
 * le carton-plume et la résine : socle sable, bâtiments crème, mousse de
 * modélisme. Le contraste ne vient plus de la couleur mais du relief calculé par
 * l'éclairage de profondeur, ce qui laisse la palette rester douce.
 */
export const MODEL_PALETTE = {
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

const VERTEX = /* glsl */ `
  attribute float classification;
  uniform sampler2D uPalette;
  uniform float uSize;
  uniform float uScale;
  uniform float uAttenuate;
  uniform float uBoost;
  uniform vec2 uClipCenter;
  uniform float uClipRadius;
  uniform float uTint;
  varying vec3 vColor;

  // Bruit de valeur : deux batiments voisins prennent des teintes legerement
  // differentes, ce qui rend la surface vivante sans qu'on ait eu besoin de
  // segmenter quoi que ce soit. La variation est spatiale, donc stable quand la
  // camera bouge — un aleatoire par point scintillerait.
  float bruit(vec2 p) {
    return fract(sin(dot(floor(p / 14.0), vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    vec4 entry = texture2D(uPalette, vec2((classification + 0.5) / 256.0, 0.5));
    vColor = entry.rgb * (1.0 + uTint * (bruit(position.xy) - 0.5));
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uAttenuate > 0.5 ? max(1.0, uBoost * uSize * uScale / max(-mv.z, 0.001)) : uSize * uBoost;
    // Une classe masquée est renvoyée hors du volume de vue : rien n'est
    // rasterisé, ce qui coûte moins qu'un discard au fragment.
    if (entry.a < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    // Meme sort pour ce qui deborde de la decoupe circulaire.
    if (uClipRadius > 0.0 && distance(position.xy, uClipCenter) > uClipRadius) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    }
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
    this.materials = new Map(); // taille de point -> ShaderMaterial
    this.shared = {
      uScale: 1, uAttenuate: attenuate ? 1 : 0, uRound: round ? 1 : 0, uBoost: 1,
      uClipCenter: [0, 0], uClipRadius: 0, uTint: 0,
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
        uClipCenter: { value: new THREE.Vector2(...this.shared.uClipCenter) },
        uClipRadius: { value: this.shared.uClipRadius },
        uTint: { value: this.shared.uTint },
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

  /** Decoupe cylindrique. Un rayon nul ou negatif la desactive. */
  setClip(center, radius) {
    this.shared.uClipCenter = center ? [center[0], center[1]] : [0, 0];
    this.shared.uClipRadius = radius ?? 0;
    this._pushShared();
  }

  /** Amplitude de la variation de teinte, 0 pour une couleur uniforme. */
  setTint(amount) {
    this.shared.uTint = amount;
    this._pushShared();
  }

  _pushShared() {
    for (const material of this.materials.values()) {
      material.uniforms.uScale.value = this.shared.uScale;
      material.uniforms.uAttenuate.value = this.shared.uAttenuate;
      material.uniforms.uRound.value = this.shared.uRound;
      material.uniforms.uBoost.value = this.shared.uBoost;
      material.uniforms.uClipCenter.value.set(this.shared.uClipCenter[0], this.shared.uClipCenter[1]);
      material.uniforms.uClipRadius.value = this.shared.uClipRadius;
      material.uniforms.uTint.value = this.shared.uTint;
    }
  }

  dispose() {
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
    this.texture.dispose();
  }
}
