import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * Relief d'un nuage de points, en une passe hors écran.
 *
 * Un nuage n'a pas de normales, donc pas d'éclairage possible : brut, il paraît
 * plat, et deux volumes qui se chevauchent forment une seule tache. Deux
 * traitements y remédient, et tous deux servent à lire, pas à décorer.
 *
 * L'**éclairage de profondeur** (*eye-dome lighting*, celui de Potree) assombrit
 * un point nettement plus loin que ses voisins : les arêtes se creusent et les
 * volumes se détachent. L'**ombrage directionnel** ajoute une direction de
 * lumière, sans quoi deux pans de toit opposés se ressemblent.
 *
 * Précaution de câblage : la passe qui **lit** la profondeur ne doit jamais
 * écrire dans la cible qui la porte. Elle écrit donc vers l'écran, et la cible
 * de scène est la seule à avoir un tampon de profondeur ; les enchaîner sur une
 * cible partagée donne un écran noir sans le moindre message.
 */

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform sampler2D tDepth;
  uniform vec2 uTexel;
  uniform float uStrength;
  uniform float uRadius;
  uniform float uNear;
  uniform float uFar;
  uniform vec3 uBackground;
  uniform vec3 uLight;
  uniform float uLightAmount;
  uniform float uLightSpread;

  float linearise(float d) {
    float z = d * 2.0 - 1.0;
    return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
  }

  // GLSL ES 1.00, que Three utilise par défaut, n'accepte ni les initialiseurs
  // de tableau ni l'indexation par une variable : les huit voisins sont donc
  // échantillonnés par appels explicites.
  float neighbour(vec2 dir, float z0) {
    float di = texture2D(tDepth, vUv + dir * uRadius * uTexel).x;
    float zi = di >= 0.9999 ? z0 : log2(linearise(di) + 1.0);
    return max(0.0, z0 - zi);
  }

  void main() {
    vec4 source = texture2D(tDiffuse, vUv);
    float d0 = texture2D(tDepth, vUv).x;

    // Le fond n'a pas de géométrie : l'ombrer reviendrait à assombrir le ciel.
    if (d0 >= 0.9999) {
      gl_FragColor = vec4(uBackground, 1.0);
      return;
    }

    float z0 = log2(linearise(d0) + 1.0);
    float response =
        neighbour(vec2( 1.0,  0.0), z0) + neighbour(vec2(-1.0,  0.0), z0)
      + neighbour(vec2( 0.0,  1.0), z0) + neighbour(vec2( 0.0, -1.0), z0)
      + neighbour(vec2( 0.7,  0.7), z0) + neighbour(vec2(-0.7,  0.7), z0)
      + neighbour(vec2( 0.7, -0.7), z0) + neighbour(vec2(-0.7, -0.7), z0);
    float shade = exp(-response * uStrength);

    // Le pas doit être large : d'un texel à l'autre, la profondeur d'un nuage de
    // points saute d'un point à son voisin, pas d'un morceau de surface au
    // suivant. Un gradient calculé sur un texel ne mesure que ce bruit.
    vec2 pas = uTexel * uLightSpread;
    float zl = linearise(texture2D(tDepth, vUv - vec2(pas.x, 0.0)).x);
    float zr = linearise(texture2D(tDepth, vUv + vec2(pas.x, 0.0)).x);
    float zd = linearise(texture2D(tDepth, vUv - vec2(0.0, pas.y)).x);
    float zu = linearise(texture2D(tDepth, vUv + vec2(0.0, pas.y)).x);
    // Le gradient est en mètres par pas : on le ramène à une pente sans unité
    // avant d'en faire une normale, sinon l'échelle de la scène décide de tout.
    float echelle = max(linearise(d0) * 0.02, 0.5);
    // Le sens des deux composantes a été fixé par la mesure, pas par le
    // raisonnement : entre l'orientation de vUv, celle de la profondeur et la
    // convention d'azimut, se tromper d'un signe est trop facile. Le contrôle
    // qui tranche : éclairer depuis l'ouest doit rendre la moitié gauche plus
    // claire que ne le fait un éclairage depuis l'est.
    vec3 normal = normalize(vec3((zr - zl) / echelle, (zu - zd) / echelle, 2.0));
    float ndotl = clamp(dot(normal, normalize(uLight)) * 0.7 + 0.6, 0.0, 1.4);

    gl_FragColor = vec4(source.rgb * shade * mix(1.0, ndotl, uLightAmount), 1.0);
  }
`;

/**
 * Direction de la lumière en espace écran, depuis un azimut et une hauteur.
 * L'azimut compte depuis le haut de l'image vers la droite — nord en haut,
 * est à droite, comme sur une carte. Le vecteur pointe **vers** la source.
 */
export function lightVector(azimuthDeg, altitudeDeg) {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (altitudeDeg * Math.PI) / 180;
  const horizontal = Math.cos(el);
  return [Math.sin(az) * horizontal, Math.cos(az) * horizontal, Math.sin(el)];
}

/**
 * Réglages retenus après essais à l'écran.
 *
 * `radius` est le plus sensible : trop petit (~1 texel) l'ombrage suit le
 * contour de chaque point et le rendu part en billes ; vers 2,4 il lit les
 * structures — arêtes de toits, ruptures de façade — et les volumes se lisent.
 */
export const RELIEF_DEFAULTS = {
  strength: 16,
  radius: 2.4,
  /** Azimut de la lumière, en degrés depuis le nord vers l'est. */
  lightAzimuth: 315,
  /** Hauteur de la lumière au-dessus de l'horizon, en degrés. */
  lightAltitude: 48,
  lightAmount: 0.55,
  /** Empreinte du gradient de profondeur, en texels. */
  lightSpread: 6,
};

export class ReliefRenderer {
  constructor(renderer, { background = 0x0e1116 } = {}) {
    this.renderer = renderer;
    this.background = new THREE.Color(background);
    this.settings = { ...RELIEF_DEFAULTS };
    this.uploaded = false;

    const depth = new THREE.DepthTexture(1, 1);
    depth.type = THREE.UnsignedIntType;
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      depthTexture: depth,
    });

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.sceneTarget.texture },
        tDepth: { value: depth },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uStrength: { value: this.settings.strength },
        uRadius: { value: this.settings.radius },
        uNear: { value: 1 },
        uFar: { value: 1000 },
        uBackground: { value: new THREE.Vector3() },
        uLight: { value: new THREE.Vector3(0, 0, 1) },
        uLightAmount: { value: this.settings.lightAmount },
        uLightSpread: { value: this.settings.lightSpread },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
    });

    this.setBackground(background);
    this._updateLight();
    this.quad = new FullScreenQuad(this.material);
  }

  setSize(width, height) {
    this.sceneTarget.setSize(width, height);
    this.material.uniforms.uTexel.value.set(1 / width, 1 / height);
  }

  /**
   * Couleur du fond, en octets bruts.
   * Surtout pas via THREE.Color : depuis la gestion des espaces colorimétriques
   * ses composantes sont linéaires, et le ciel ressortirait bien trop sombre.
   */
  setBackground(hex) {
    this.background.set(hex);
    this.material.uniforms.uBackground.value.set(
      ((hex >> 16) & 0xff) / 255,
      ((hex >> 8) & 0xff) / 255,
      (hex & 0xff) / 255,
    );
  }

  set(settings) {
    Object.assign(this.settings, settings);
    const u = this.material.uniforms;
    u.uStrength.value = this.settings.strength;
    u.uRadius.value = this.settings.radius;
    u.uLightAmount.value = this.settings.lightAmount;
    u.uLightSpread.value = this.settings.lightSpread;
    this._updateLight();
  }

  _updateLight() {
    const [x, y, z] = lightVector(this.settings.lightAzimuth, this.settings.lightAltitude);
    this.material.uniforms.uLight.value.set(x, y, z);
  }

  render(scene, camera) {
    // Une fois le quad plein écran envoyé au GPU, il y reste : `renderer.info`
    // compte ce qui est alloué, pas ce qui vient d'être dessiné. Le contrôle
    // anti-fuite doit donc en tenir compte même après retour au rendu direct.
    this.uploaded = true;
    const u = this.material.uniforms;
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;

    const previous = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.sceneTarget);
    this.renderer.clear();
    this.renderer.render(scene, camera);

    this.renderer.setRenderTarget(null);
    this.quad.render(this.renderer);
    this.renderer.setRenderTarget(previous);
  }

  dispose() {
    this.sceneTarget.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
