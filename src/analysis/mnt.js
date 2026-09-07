/**
 * Modèle numérique de terrain officiel de l'IGN.
 *
 * L'IGN publie, dérivés du même LiDAR HD que les nuages de points, trois
 * rasters au pas de 50 cm : le MNT (sol), le MNS (sursol) et le MNH (leur
 * différence). Le MNT nous intéresse parce qu'il répond exactement à la
 * question que notre grille calculée peinait à trancher : quelle est l'altitude
 * du sol *sous le couvert*, là où le laser n'a presque rien renvoyé.
 *
 * Le service WMS accepte une emprise et une taille arbitraires, donc on demande
 * précisément la zone chargée à la résolution voulue, sans découper en dalles.
 *
 * Le format demandé est `image/x-bil;bits=32` : un flux brut de float32,
 * sans en-tête ni compression. C'est le choix qui évite d'ajouter un décodeur
 * GeoTIFF — quelques lignes de DataView suffisent, et rien ne peut se glisser
 * entre l'octet reçu et l'altitude lue.
 *
 * Licence Etalab 2.0, comme le reste de la Géoplateforme : pas de clé.
 */

import { SampledGrid } from './terrain.js';

export const MNT_LAYER = 'IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93';
export const WMS_BASE = 'https://data.geopf.fr/wms-r/wms';

/** Valeur rendue hors couverture. Vérifiée en mer et hors métropole. */
export const NODATA = -9999;

/** Le service refuse au-delà ; annoncé dans ses capacités. */
export const MAX_PIXELS = 5010;

/**
 * URL d'une requête GetMap, en Lambert-93.
 *
 * `bbox` est en coordonnées absolues : [minX, minY, maxX, maxY]. Le WMS 1.3.0
 * impose l'ordre des axes défini par le CRS, et pour l'EPSG:2154 c'est bien
 * est-nord — contrairement à l'EPSG:4326, où il faut inverser.
 */
export function mntUrl({ bbox, pixels, layer = MNT_LAYER, base = WMS_BASE }) {
  if (!Number.isInteger(pixels) || pixels < 2 || pixels > MAX_PIXELS) {
    throw new Error(`pixels doit être un entier entre 2 et ${MAX_PIXELS}`);
  }
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetMap',
    LAYERS: layer,
    STYLES: '',
    CRS: 'EPSG:2154',
    BBOX: bbox.join(','),
    WIDTH: String(pixels),
    HEIGHT: String(pixels),
    FORMAT: 'image/x-bil;bits=32',
  });
  return `${base}?${params}`;
}

/**
 * Décode le flux BIL en grille.
 *
 * Deux pièges, et le second est silencieux :
 *
 * 1. Les octets sont en little-endian. `Float32Array` suivrait l'endianness de
 *    la machine, ce qui marcherait ici et nulle part ailleurs ; `DataView` le
 *    dit explicitement, pour le prix d'un appel par pixel.
 * 2. **La première ligne du raster est au NORD**, comme dans toute image, alors
 *    que la grille indexe ses lignes du sud vers le nord (v croissant dans la
 *    texture). Sans le retournement, le terrain est correct en tout point de
 *    l'axe médian et faux ailleurs, d'autant plus que la pente est forte —
 *    exactement le genre d'erreur qu'un contrôle sur une zone plate ne verrait
 *    jamais.
 */
export function decodeBil(buffer, pixels) {
  const attendu = pixels * pixels * 4;
  if (buffer.byteLength !== attendu) {
    throw new Error(`BIL de ${buffer.byteLength} octets, ${attendu} attendus pour ${pixels}²`);
  }
  const vue = new DataView(buffer);
  const height = new Float32Array(pixels * pixels);
  const known = new Uint8Array(pixels * pixels);
  let observed = 0;

  for (let ligne = 0; ligne < pixels; ligne += 1) {
    const j = pixels - 1 - ligne; // ligne 0 = nord = j maximal
    for (let i = 0; i < pixels; i += 1) {
      const z = vue.getFloat32((ligne * pixels + i) * 4, true);
      const k = j * pixels + i;
      if (Number.isFinite(z) && z > NODATA + 1) {
        height[k] = z;
        known[k] = 1;
        observed += 1;
      } else {
        height[k] = NODATA;
      }
    }
  }
  return { height, known, observed };
}

/**
 * Terrain officiel, prêt à l'emploi dès sa construction.
 *
 * Contrairement à la grille calculée, il n'y a rien à accumuler ni à combler :
 * l'IGN a déjà fait ce travail, avec l'ensemble des points de la dalle et non
 * seulement ceux que le niveau de détail courant a chargés.
 */
export class MntGrid extends SampledGrid {
  /**
   * `zOffset` ramène les altitudes dans le repère de la scène.
   *
   * C'est la couture qui compte ici : le raster est en NGF-IGN69 absolu, tandis
   * que les points ont perdu l'origine de la dalle avant d'être convertis en
   * Float32. Comparer les deux directement donne un écart constant de
   * plusieurs centaines de mètres — mesuré : −632,36 m sur la dalle de
   * Toulouse, soit très exactement son origine. L'erreur est franche, mais rien
   * ne la signale : les hauteurs de canopée sortent simplement toutes négatives.
   *
   * Le sentinelle d'absence ne se décale pas : le rendu la reconnaît à sa
   * valeur, et une absence translatée deviendrait une altitude.
   */
  constructor({ center, size, cells, height, known, observed, zOffset = 0 }) {
    super({ center, size, cells });
    if (height.length !== cells * cells) throw new Error('taille de grille incohérente');
    this.height.set(height);
    this.known.set(known);
    if (zOffset !== 0) {
      for (let k = 0; k < this.height.length; k += 1) {
        if (this.known[k]) this.height[k] += zOffset;
      }
    }
    this.observed = observed;
    this.zOffset = zOffset;
    this.filled = true;
    this.source = 'mnt';
  }
}

/**
 * Va chercher le MNT sur l'emprise demandée.
 *
 * `origin` translate le repère : la grille vit en coordonnées de scène comme
 * les points, mais le WMS ne connaît que le Lambert-93 absolu.
 *
 * Rend `null` plutôt que de lever quand la zone n'est pas couverte : le
 * programme LiDAR HD est en cours, et une dalle de points peut exister avant
 * son MNT. L'appelant retombe alors sur la grille calculée — et doit le dire.
 */
export async function fetchMnt({
  center = [0, 0],
  size,
  cells,
  origin,
  minCoverage = 0.5,
  fetchImpl,
  signal,
} = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const bbox = [
    center[0] + origin[0] - size / 2,
    center[1] + origin[1] - size / 2,
    center[0] + origin[0] + size / 2,
    center[1] + origin[1] + size / 2,
  ];
  const reponse = await doFetch(mntUrl({ bbox, pixels: cells }), { signal });
  if (!reponse.ok) throw new Error(`MNT : HTTP ${reponse.status}`);

  // Une erreur WMS arrive en XML avec un code 200 : c'est la taille qui la
  // trahit, un rapport d'erreur ne pesant jamais les 4 Mo attendus.
  const buffer = await reponse.arrayBuffer();
  if (buffer.byteLength !== cells * cells * 4) {
    const debut = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(400, buffer.byteLength)));
    throw new Error(`MNT : réponse inattendue (${buffer.byteLength} o) — ${debut.slice(0, 200)}`);
  }

  const { height, known, observed } = decodeBil(buffer, cells);
  if (observed / (cells * cells) < minCoverage) return null;
  // La grille vit en repère de scène, comme les points : même translation
  // planimétrique, et même retrait de l'altitude d'origine.
  return new MntGrid({ center, size, cells, height, known, observed, zOffset: -origin[2] });
}
