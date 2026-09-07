/**
 * Empreinte au sol du champ de vision, pour situer la scène 3D sur la carte.
 *
 * La carte et la scène sont deux panneaux séparés : rien ne disait jusqu'ici où
 * l'on regardait, ni dans quelle direction. Un secteur posé sur la carte répond
 * aux deux questions d'un coup.
 *
 * C'est une **approximation assumée**. La projection exacte du tronc de vue sur
 * le sol part à l'infini dès que la caméra vise l'horizon, et un polygone
 * infini n'a rien à faire sur une carte. On borne donc la portée à la distance
 * du point visé, majorée d'un tiers : le secteur dit « je regarde par là,
 * jusqu'à peu près là », ce qui est exactement ce qu'on veut savoir.
 */

/** Au-delà, la caméra est considérée à la verticale de sa cible. */
const HORIZONTALE_MINIMALE = 1e-6;

/**
 * Demi-angle horizontal du champ de vision.
 *
 * Three exprime son `fov` **verticalement** ; l'horizontal s'en déduit par le
 * rapport d'image, et les confondre donne un secteur trop étroit sur un écran
 * large — d'autant plus faux que la fenêtre est large.
 */
export function horizontalHalfAngle(fovRadians, aspect) {
  return Math.atan(Math.tan(fovRadians / 2) * Math.max(aspect, 1e-6));
}

/**
 * Secteur au sol regardé par la caméra, en coordonnées absolues.
 *
 * `camera` et `target` sont en Lambert-93 ; seules leurs composantes planes
 * comptent. Rend `null` si les deux points sont confondus, cas où il n'y a
 * aucune direction à montrer.
 *
 * Quand la caméra est à la verticale de sa cible — vue au zénith — il n'y a pas
 * davantage de direction, mais il y a bien une zone regardée : le secteur
 * devient alors un disque complet, ce qui décrit la situation au lieu de
 * choisir un azimut au hasard.
 */
export function viewFootprint({
  camera,
  target,
  fovRadians = (50 * Math.PI) / 180,
  aspect = 1,
  segments = 12,
  reachFactor = 1.35,
} = {}) {
  if (!camera || !target) return null;
  const dx = target[0] - camera[0];
  const dy = target[1] - camera[1];
  const horizontale = Math.hypot(dx, dy);
  const portee = Math.max(horizontale, 1) * reachFactor;

  if (horizontale < HORIZONTALE_MINIMALE) {
    // Vue au zénith : aucun azimut, mais une emprise bien réelle.
    return {
      apex: [target[0], target[1]],
      target: [target[0], target[1]],
      reach: portee,
      zenith: true,
      polygon: cercle(target, portee, Math.max(segments, 3) * 2),
    };
  }

  const demi = horizontalHalfAngle(fovRadians, aspect);
  const azimut = Math.atan2(dy, dx);
  const n = Math.max(2, Math.round(segments));
  const polygon = [[camera[0], camera[1]]];
  for (let i = 0; i <= n; i += 1) {
    const a = azimut - demi + (2 * demi * i) / n;
    polygon.push([camera[0] + portee * Math.cos(a), camera[1] + portee * Math.sin(a)]);
  }
  return {
    apex: [camera[0], camera[1]],
    target: [target[0], target[1]],
    reach: portee,
    halfAngle: demi,
    zenith: false,
    polygon,
  };
}

function cercle(centre, rayon, n) {
  const points = [];
  for (let i = 0; i < n; i += 1) {
    const a = (2 * Math.PI * i) / n;
    points.push([centre[0] + rayon * Math.cos(a), centre[1] + rayon * Math.sin(a)]);
  }
  return points;
}
