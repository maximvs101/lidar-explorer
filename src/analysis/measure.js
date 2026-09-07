/**
 * Mesures entre deux points de la scène.
 *
 * Les positions arrivent dans le repère local du rendu ; les résultats sont
 * rendus en coordonnées absolues, Lambert-93 et NGF-IGN69, parce qu'une mesure
 * qui ne peut pas se reporter sur une carte ne sert à rien.
 *
 * Ces altitudes sont orthométriques, pas ellipsoïdales : les comparer à un
 * relevé GNSS brut demande une conversion de géoïde, de l'ordre de 45 à 50 m en
 * France.
 */

/** Passe du repère de scène aux coordonnées absolues. */
export function toAbsolute(point, origin) {
  return {
    x: point.x + origin[0],
    y: point.y + origin[1],
    z: point.z + origin[2],
  };
}

/**
 * Mesure entre deux points absolus.
 *
 * La pente est exprimée à la fois en pourcentage et en degrés : ce ne sont pas
 * deux écritures du même nombre — 100 % vaut 45°, et la confusion est courante.
 * Elle n'a pas de sens quand les deux points sont à la verticale l'un de
 * l'autre, d'où l'infini assumé plutôt qu'une division silencieuse par zéro.
 */
export function measureBetween(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const horizontal = Math.hypot(dx, dy);
  const distance = Math.hypot(horizontal, dz);

  return {
    from: a,
    to: b,
    dx,
    dy,
    dz,
    horizontal,
    distance,
    slopePercent: horizontal > 0 ? (100 * dz) / horizontal : (dz === 0 ? 0 : Infinity),
    slopeDegrees: horizontal > 0 ? (Math.atan2(dz, horizontal) * 180) / Math.PI : (dz === 0 ? 0 : 90),
    /** Azimut de a vers b, en degrés depuis le nord de la projection. */
    azimuth: horizontal > 0 ? ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360 : NaN,
  };
}

/**
 * Exactitude annoncée du LiDAR HD, en mètres.
 *
 * Ce sont les chiffres du producteur, pas les nôtres : 10 cm en altimétrie,
 * 50 cm en planimétrie. Ils décrivent la position d'un point du nuage, et non
 * la position de l'objet qu'on croit viser.
 */
export const LIDAR_HD_PRECISION = { altimetrie: 0.1, planimetrie: 0.5 };

/**
 * Ce que vaut une mesure faite dans la scène.
 *
 * Deux termes s'ajoutent, et le second est souvent le plus grand :
 *
 * 1. L'exactitude du nuage lui-même, celle du producteur.
 * 2. **L'échantillonnage.** On ne vise pas un objet, on vise le point affiché le
 *    plus proche. Au niveau de détail courant, les points sont espacés de
 *    `spacing` mètres ; l'arête réelle peut donc se trouver jusqu'à la moitié de
 *    cet espacement à côté. À 3 m d'espacement, ce terme pèse trois fois
 *    l'exactitude planimétrique annoncée.
 *
 * Les deux termes sont indépendants, d'où la somme quadratique. Et la distance
 * entre deux points cumule l'incertitude des deux, d'où le facteur √2.
 *
 * L'altimétrie ne subit pas l'échantillonnage de la même façon : le point visé
 * porte sa propre altitude, mesurée, pas interpolée entre voisins.
 */
export function measurementUncertainty(spacing) {
  const echantillon = Number.isFinite(spacing) && spacing > 0 ? spacing / 2 : 0;
  const plan = Math.hypot(LIDAR_HD_PRECISION.planimetrie, echantillon);
  return {
    spacing: Number.isFinite(spacing) && spacing > 0 ? spacing : NaN,
    horizontalPoint: plan,
    verticalPoint: LIDAR_HD_PRECISION.altimetrie,
    horizontalDistance: plan * Math.SQRT2,
    verticalDistance: LIDAR_HD_PRECISION.altimetrie * Math.SQRT2,
  };
}

/**
 * Formate une longueur avec une précision qui ne ment pas.
 *
 * Le LiDAR HD est donné pour une dizaine de centimètres en altimétrie ; afficher
 * des millimètres laisserait croire à une exactitude que la donnée n'a pas.
 */
export function formatDistance(metres) {
  if (!Number.isFinite(metres)) return '—';
  if (Math.abs(metres) >= 1000) return `${(metres / 1000).toFixed(2)} km`;
  if (Math.abs(metres) >= 10) return `${metres.toFixed(1)} m`;
  return `${metres.toFixed(2)} m`;
}

export function formatSlope(percent, degrees) {
  if (!Number.isFinite(percent)) return 'verticale';
  return `${percent.toFixed(1)} % · ${degrees.toFixed(1)}°`;
}
