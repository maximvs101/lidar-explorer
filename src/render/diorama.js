import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * Rendu « maquette » : trois passes hors écran.
 *
 * Un nuage de points n'a pas de normales, donc pas d'éclairage possible : brut,
 * il paraît plat, et deux bâtiments qui se chevauchent forment une seule tache.
 * L'éclairage de profondeur (*eye-dome lighting*) reconstitue le relief à partir
 * du seul tampon de profondeur — un point nettement plus loin que ses voisins
 * est assombri, ce qui creuse les arêtes et détache les volumes.
 *
 * Précaution de câblage : la passe qui **lit** la profondeur ne doit jamais
 * écrire dans la cible qui la porte. Les deux cibles sont donc distinctes, et
 * seule la première a un tampon de profondeur ; les enchaîner sur une cible
 * partagée donne un écran noir et un `INVALID_OPERATION` silencieux.
 */

const EDL_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const EDL_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform sampler2D tDepth;
  uniform vec2 uTexel;
  uniform float uStrength;
  uniform float uRadius;
  uniform float uNear;
  uniform float uFar;
  uniform float uSaturation;
  uniform float uVignette;
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

    // Modele directionnel. L'ombrage de profondeur creuse les aretes mais ne dit
    // pas d'ou vient la lumiere : tout est eclaire pareil et les pans de toit
    // opposes se ressemblent. On estime donc une normale par differences finies
    // sur la profondeur, et on ajoute un simple produit scalaire.
    // Le pas doit etre large : d'un texel a l'autre, la profondeur d'un nuage de
    // points saute d'un point a son voisin, pas d'un morceau de surface au
    // suivant. Un gradient calcule sur un texel ne mesure que ce bruit.
    vec2 pas = uTexel * uLightSpread;
    float zl = linearise(texture2D(tDepth, vUv - vec2(pas.x, 0.0)).x);
    float zr = linearise(texture2D(tDepth, vUv + vec2(pas.x, 0.0)).x);
    float zd = linearise(texture2D(tDepth, vUv - vec2(0.0, pas.y)).x);
    float zu = linearise(texture2D(tDepth, vUv + vec2(0.0, pas.y)).x);
    // Le gradient est en metres par pas : on le ramene a une pente sans unite
    // avant d'en faire une normale, sinon l'echelle de la scene decide de tout.
    float echelle = max(linearise(d0) * 0.02, 0.5);
    // Le sens des deux composantes a ete fixe par la mesure, pas par le
    // raisonnement : entre l'orientation de vUv, celle de la profondeur et la
    // convention d'azimut, se tromper d'un signe est trop facile. Le controle
    // qui tranche : eclairer depuis l'ouest doit rendre la moitie gauche plus
    // claire que ne le fait un eclairage depuis l'est.
    vec3 normal = normalize(vec3((zr - zl) / echelle, (zu - zd) / echelle, 2.0));
    float ndotl = clamp(dot(normal, normalize(uLight)) * 0.7 + 0.6, 0.0, 1.4);

    vec3 color = source.rgb * shade * mix(1.0, ndotl, uLightAmount);

    // Un peu de saturation : la maquette assume la couleur, le scan la subit.
    float grey = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(vec3(grey), color, uSaturation);

    float r = distance(vUv, vec2(0.5));
    color *= 1.0 - uVignette * smoothstep(0.35, 0.95, r);

    gl_FragColor = vec4(color, 1.0);
  }
`;

const TILT_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;
  uniform float uFocus;
  uniform float uBand;
  uniform float uAmount;

  void main() {
    // Le flou d'un diorama ne dépend pas de la profondeur mais de la hauteur à
    // l'écran : c'est ce qui donne l'illusion d'un objet vu de très près.
    float distance = abs(vUv.y - uFocus);
    float blur = smoothstep(uBand, uBand + 0.32, distance) * uAmount;

    if (blur < 0.001) {
      gl_FragColor = texture2D(tDiffuse, vUv);
      return;
    }

    vec3 sum = vec3(0.0);
    float total = 0.0;
    for (int i = -4; i <= 4; i++) {
      float w = exp(-float(i * i) / 8.0);
      vec2 o = vec2(float(i), 0.0) * uTexel * blur * 3.0;
      vec2 p = vec2(0.0, float(i)) * uTexel * blur * 3.0;
      sum += texture2D(tDiffuse, vUv + o).rgb * w;
      sum += texture2D(tDiffuse, vUv + p).rgb * w;
      total += 2.0 * w;
    }
    gl_FragColor = vec4(sum / total, 1.0);
  }
`;

/**
 * Reglages retenus apres essais a l'ecran.
 *
 * `radius` est le plus sensible : trop petit (~1 texel) l'ombrage suit le
 * contour de chaque point et le rendu part en billes ; vers 2,4 il lit les
 * structures — aretes de toits, ruptures de facade — et les volumes se lisent.
 */
/**
 * Direction de la lumiere en espace ecran, depuis un azimut et une hauteur.
 * L'azimut compte depuis le haut de l'image vers la droite — nord en haut,
 * est a droite, comme sur une carte. Le vecteur pointe **vers** la source.
 */
export function lightVector(azimuthDeg, altitudeDeg) {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (altitudeDeg * Math.PI) / 180;
  const horizontal = Math.cos(el);
  return [Math.sin(az) * horizontal, Math.cos(az) * horizontal, Math.sin(el)];
}

export const DIORAMA_DEFAULTS = {
  strength: 16,
  radius: 2.4,
  /** Azimut de la lumiere, en degres depuis le nord vers l'est. */
  lightAzimuth: 315,
  /** Hauteur de la lumiere au-dessus de l'horizon, en degres. */
  lightAltitude: 48,
  lightAmount: 0.55,
  /** Empreinte du gradient de profondeur, en texels. */
  lightSpread: 6,
  /** Amplitude de la variation de teinte entre batiments voisins. */
  tint: 0.16,
  saturation: 1.18,
  vignette: 0.24,
  tiltFocus: 0.54,
  tiltBand: 0.22,
  tiltAmount: 0.85,
};

export class DioramaRenderer {
  constructor(renderer, { background = 0x0e1116 } = {}) {
    this.renderer = renderer;
    this.background = new THREE.Color(background);
    this.settings = { ...DIORAMA_DEFAULTS };
    this.enabled = false;
    this.uploaded = false;

    // Seule la première cible porte la profondeur : c'est celle qu'on lit.
    const depth = new THREE.DepthTexture(1, 1);
    depth.type = THREE.UnsignedIntType;
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      depthTexture: depth,
    });
    this.edlTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });

    this.edlMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.sceneTarget.texture },
        tDepth: { value: depth },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uStrength: { value: this.settings.strength },
        uRadius: { value: this.settings.radius },
        uNear: { value: 1 },
        uFar: { value: 1000 },
        uSaturation: { value: this.settings.saturation },
        uVignette: { value: this.settings.vignette },
        uBackground: { value: new THREE.Vector3(this.background.r, this.background.g, this.background.b) },
        uLight: { value: new THREE.Vector3(0, 0, 1) },
        uLightAmount: { value: this.settings.lightAmount },
        uLightSpread: { value: this.settings.lightSpread },
      },
      vertexShader: EDL_VERT,
      fragmentShader: EDL_FRAG,
    });

    this.tiltMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.edlTarget.texture },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uFocus: { value: this.settings.tiltFocus },
        uBand: { value: this.settings.tiltBand },
        uAmount: { value: this.settings.tiltAmount },
      },
      vertexShader: EDL_VERT,
      fragmentShader: TILT_FRAG,
    });

    this._updateLight();
    this.edlQuad = new FullScreenQuad(this.edlMaterial);
    this.tiltQuad = new FullScreenQuad(this.tiltMaterial);
  }

  setSize(width, height) {
    this.sceneTarget.setSize(width, height);
    this.edlTarget.setSize(width, height);
    const texel = new THREE.Vector2(1 / width, 1 / height);
    this.edlMaterial.uniforms.uTexel.value.copy(texel);
    this.tiltMaterial.uniforms.uTexel.value.copy(texel);
  }

  set(settings) {
    Object.assign(this.settings, settings);
    const u = this.edlMaterial.uniforms;
    u.uStrength.value = this.settings.strength;
    u.uRadius.value = this.settings.radius;
    u.uSaturation.value = this.settings.saturation;
    u.uVignette.value = this.settings.vignette;
    u.uLightAmount.value = this.settings.lightAmount;
    u.uLightSpread.value = this.settings.lightSpread;
    this._updateLight();
    const t = this.tiltMaterial.uniforms;
    t.uFocus.value = this.settings.tiltFocus;
    t.uBand.value = this.settings.tiltBand;
    t.uAmount.value = this.settings.tiltAmount;
  }

  /**
   * Direction de la lumiere en espace ecran, depuis un azimut et une hauteur.
   * L'azimut compte depuis le haut de l'image vers la droite, comme sur une
   * carte ou le nord est en haut.
   */
  _updateLight() {
    const [x, y, z] = lightVector(this.settings.lightAzimuth, this.settings.lightAltitude);
    this.edlMaterial.uniforms.uLight.value.set(x, y, z);
  }

  /** Rend la scène avec les trois passes, vers le canvas. */
  render(scene, camera) {
    // Une fois le quad plein ecran envoye au GPU, il y reste : `renderer.info`
    // compte ce qui est alloue, pas ce qui vient d'etre dessine. Le controle
    // anti-fuite doit donc en tenir compte meme apres retour en mode lecture.
    this.uploaded = true;
    const u = this.edlMaterial.uniforms;
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;

    const previous = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.sceneTarget);
    this.renderer.clear();
    this.renderer.render(scene, camera);

    this.renderer.setRenderTarget(this.edlTarget);
    this.edlQuad.render(this.renderer);

    this.renderer.setRenderTarget(null);
    this.tiltQuad.render(this.renderer);
    this.renderer.setRenderTarget(previous);
  }

  dispose() {
    this.sceneTarget.dispose();
    this.edlTarget.dispose();
    this.edlMaterial.dispose();
    this.tiltMaterial.dispose();
    this.edlQuad.dispose();
    this.tiltQuad.dispose();
  }
}
