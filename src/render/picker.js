import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * Retrouve la position 3D du point sous le curseur.
 *
 * Pas de lancer de rayon : sur trois millions de points sans structure
 * d'accélération, il faudrait tous les parcourir à chaque clic. On lit plutôt le
 * tampon de profondeur, ce qui coûte le même prix quel que soit le nombre de
 * points, et donne exactement ce que l'œil voit — le point effectivement visible
 * à cet endroit, pas le plus proche d'un rayon idéal.
 *
 * La profondeur ne se lit pas directement : WebGL interdit `readPixels` sur un
 * attachement de profondeur. Elle est donc réencodée en quatre octets par une
 * passe plein écran, à la manière de Three. L'encodage RGBA8 est préféré à une
 * cible flottante, qui dépendrait d'une extension non garantie.
 */

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  #include <packing>
  varying vec2 vUv;
  uniform sampler2D tDepth;
  void main() {
    gl_FragColor = packDepthToRGBA(texture2D(tDepth, vUv).x);
  }
`;

/**
 * Dépaquetage, miroir exact de `packDepthToRGBA` de Three.
 *
 * Attention à la convention : depuis les versions récentes, c'est le canal
 * **rouge** qui porte le poids fort et l'alpha le poids faible. L'ordre inverse,
 * qui a longtemps prévalu et qu'on trouve encore partout, décode sans erreur
 * une valeur entièrement fausse — mesuré ici : 0,003 au lieu de 0,999, soit un
 * point à 20 cm de la caméra au lieu de 400 m.
 *
 *   const vec4 PackFactors = vec4( 1.0, 256.0, 256.0*256.0, 256.0*256.0*256.0 );
 *   UnpackFactors4 = vec4( UnpackDownscale / PackFactors.rgb, 1.0 / PackFactors.a );
 */
const DOWNSCALE = 255 / 256;
const FACTORS = [DOWNSCALE / 1, DOWNSCALE / 256, DOWNSCALE / (256 * 256), 1 / (256 * 256 * 256)];

export function unpackDepth(r, g, b, a) {
  return (
    (r / 255) * FACTORS[0] +
    (g / 255) * FACTORS[1] +
    (b / 255) * FACTORS[2] +
    (a / 255) * FACTORS[3]
  );
}

export class ScenePicker {
  constructor(renderer) {
    this.renderer = renderer;

    const depth = new THREE.DepthTexture(1, 1);
    depth.type = THREE.UnsignedIntType;
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
      depthBuffer: true,
      depthTexture: depth,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    this.depthTarget = new THREE.WebGLRenderTarget(1, 1, {
      depthBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });

    this.material = new THREE.ShaderMaterial({
      uniforms: { tDepth: { value: depth } },
      vertexShader: VERT,
      fragmentShader: FRAG,
    });
    this.quad = new FullScreenQuad(this.material);
    this.pixel = new Uint8Array(4);
    this.uploaded = false;
  }

  setSize(width, height) {
    this.sceneTarget.setSize(width, height);
    this.depthTarget.setSize(width, height);
  }

  /**
   * Position monde sous le pixel (x, y), en coordonnées de scène.
   * Rend `null` si le rayon ne rencontre rien — le fond a une profondeur de 1,
   * et l'interpréter donnerait un point à la distance maximale de la caméra.
   */
  pick(scene, camera, x, y) {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    if (size.x < 2 || size.y < 2) return null;
    this.setSize(size.x, size.y);
    this.uploaded = true;

    const previous = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.sceneTarget);
    this.renderer.clear();
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(this.depthTarget);
    this.quad.render(this.renderer);

    // L'origine de readPixels est en bas à gauche, celle des évènements en haut.
    const px = Math.round(x);
    const py = Math.round(size.y - 1 - y);
    this.renderer.readRenderTargetPixels(this.depthTarget, px, py, 1, 1, this.pixel);
    this.renderer.setRenderTarget(previous);

    const depth = unpackDepth(this.pixel[0], this.pixel[1], this.pixel[2], this.pixel[3]);
    if (depth >= 0.999999) return null;

    const ndc = new THREE.Vector3(
      (px / size.x) * 2 - 1,
      (py / size.y) * 2 - 1,
      depth * 2 - 1,
    );
    return ndc.unproject(camera);
  }

  dispose() {
    this.sceneTarget.dispose();
    this.depthTarget.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
