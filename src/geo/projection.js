import proj4 from 'proj4';

/**
 * Lambert-93 (EPSG:2154), la projection légale de la France métropolitaine et
 * celle dans laquelle sont exprimées les dalles LiDAR HD.
 *
 * Les altitudes des dalles sont en NGF-IGN69, pas ellipsoïdales : dès qu'on les
 * croisera avec du GNSS ou de l'éphéméride, il faudra une conversion de géoïde
 * (~45-50 m d'écart en France). Ce module ne touche qu'à la planimétrie.
 */
export const LAMBERT93 = 'EPSG:2154';
export const WGS84 = 'EPSG:4326';

proj4.defs(
  LAMBERT93,
  '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 ' +
    '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
);

/** [longitude, latitude] en degrés -> [x, y] en mètres Lambert-93. */
export function toLambert93(lon, lat) {
  const [x, y] = proj4(WGS84, LAMBERT93, [lon, lat]);
  return [x, y];
}

/** [x, y] en mètres Lambert-93 -> [longitude, latitude] en degrés. */
export function toWgs84(x, y) {
  const [lon, lat] = proj4(LAMBERT93, WGS84, [x, y]);
  return [lon, lat];
}

/**
 * Emprise approximative du Lambert-93 sur la métropole. Sert à écarter tout de
 * suite un clic hors zone, plutôt que d'interroger le serveur pour rien.
 * Volontairement large : mieux vaut laisser passer une requête inutile que
 * refuser un lieu réellement couvert.
 */
export const METROPOLE_BOUNDS = { minX: 0, minY: 6_000_000, maxX: 1_300_000, maxY: 7_150_000 };

export function isWithinMetropole(x, y) {
  return (
    x >= METROPOLE_BOUNDS.minX &&
    x <= METROPOLE_BOUNDS.maxX &&
    y >= METROPOLE_BOUNDS.minY &&
    y <= METROPOLE_BOUNDS.maxY
  );
}

/** Nom de la dalle kilométrique contenant ce point, au format IGN (ex. « 0573_6278 »). */
export function tileNameAt(x, y) {
  const km = (v) => String(Math.floor(v / 1000)).padStart(4, '0');
  // Le nom porte le coin nord-ouest : l'abscisse est arrondie vers le bas,
  // l'ordonnée vers le haut.
  return `${km(x)}_${String(Math.ceil(y / 1000)).padStart(4, '0')}`;
}
