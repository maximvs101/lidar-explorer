/**
 * Les trois rasters dérivés du LiDAR HD, publiés par l'IGN.
 *
 * Dérivés du même relevé que les nuages de points, mais de la **totalité** des
 * points et non du niveau de détail affiché, au pas de 50 cm :
 *
 * - **MNT** — le sol. Il remplace le terrain qu'on reconstruisait depuis les
 *   seuls points classés sol, qui avait des trous sous le couvert.
 * - **MNS** — la surface, c'est-à-dire le dessus de tout : cimes, toitures,
 *   ouvrages. Sert de référence pour juger ce qui dépasse.
 * - **MNH** — la hauteur au-dessus du sol, soit la différence des deux autres.
 *   Vérifié : la médiane de `MNS − MNT − MNH` est nulle, et 0,14 % des pixels
 *   seulement s'en écartent de plus d'un mètre, tous aux bordures d'objets.
 *
 * Le service WMS accepte une emprise et une taille arbitraires, donc on demande
 * précisément la zone chargée à la résolution voulue, sans découper en dalles.
 *
 * Le format demandé est `image/x-bil;bits=32` : un flux brut de float32,
 * sans en-tête ni compression. C'est le choix qui évite d'ajouter un décodeur
 * GeoTIFF — quelques lignes de DataView suffisent, et rien ne peut se glisser
 * entre l'octet reçu et la valeur lue.
 *
 * Licence Etalab 2.0, comme le reste de la Géoplateforme : pas de clé.
 */

import { SampledGrid } from './terrain.js';

export const WMS_BASE = 'https://data.geopf.fr/wms-r/wms';

/**
 * `altitude` distingue les deux natures de raster, et ce n'est pas un détail :
 * MNT et MNS portent des altitudes NGF, que la scène doit ramener dans son
 * repère local ; le MNH porte déjà une **hauteur relative**, à laquelle
 * appliquer la même translation donnerait des arbres à −600 m.
 */
export const PRODUITS = {
  mnt: {
    layer: 'IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93',
    libelle: 'MNT',
    altitude: true,
  },
  mns: {
    layer: 'IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93',
    libelle: 'MNS',
    altitude: true,
  },
  mnh: {
    layer: 'IGNF_LIDAR-HD_MNH_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93',
    libelle: 'MNH',
    altitude: false,
  },
};

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
export function rasterUrl({ bbox, pixels, produit = 'mnt', base = WMS_BASE }) {
  const p = PRODUITS[produit];
  if (!p) throw new Error(`produit inconnu : ${produit}`);
  if (!Number.isInteger(pixels) || pixels < 2 || pixels > MAX_PIXELS) {
    throw new Error(`pixels doit être un entier entre 2 et ${MAX_PIXELS}`);
  }
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetMap',
    LAYERS: p.layer,
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
 * Raster officiel, prêt à l'emploi dès sa construction.
 *
 * Contrairement à la grille calculée, il n'y a rien à accumuler ni à combler :
 * l'IGN a déjà fait ce travail, avec l'ensemble des points de la dalle et non
 * seulement ceux que le niveau de détail courant a chargés.
 */
export class RasterGrid extends SampledGrid {
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
   * Le MNH, lui, est déjà une hauteur relative : il ne se translate pas. C'est
   * `PRODUITS[…].altitude` qui tranche, pas l'appelant.
   *
   * La sentinelle d'absence ne se décale pas non plus : le rendu la reconnaît à
   * sa valeur, et une absence translatée deviendrait une altitude.
   */
  constructor({ center, size, cells, height, known, observed, zOffset = 0, produit = 'mnt' }) {
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
    this.produit = produit;
    this.source = produit;
  }

  /**
   * Distribution des valeurs sur une emprise, en repère de scène.
   *
   * C'est ce que le raster a d'irremplaçable : il couvre toute la zone au même
   * pas, indépendamment du niveau de détail chargé. Les statistiques tirées des
   * points, elles, portent sur ce que l'octree a livré — et la composition en
   * classes y varie d'un facteur 1,46 selon le niveau.
   *
   * Le maximum brut est rendu, mais il n'est jamais qu'un pixel : c'est le
   * centile qui décrit la canopée, pas son accident le plus haut.
   */
  distribution(center, size, { minValue = -Infinity } = {}) {
    const demi = size / 2;
    const i0 = Math.max(0, Math.floor((center[0] - demi - this.minX) / this.step));
    const i1 = Math.min(this.cells - 1, Math.floor((center[0] + demi - this.minX) / this.step));
    const j0 = Math.max(0, Math.floor((center[1] - demi - this.minY) / this.step));
    const j1 = Math.min(this.cells - 1, Math.floor((center[1] + demi - this.minY) / this.step));

    const valeurs = [];
    let total = 0;
    let inconnues = 0;
    for (let j = j0; j <= j1; j += 1) {
      for (let i = i0; i <= i1; i += 1) {
        total += 1;
        const k = j * this.cells + i;
        if (!this.known[k]) { inconnues += 1; continue; }
        if (this.height[k] >= minValue) valeurs.push(this.height[k]);
      }
    }
    if (valeurs.length === 0) {
      return { count: 0, total, unknown: inconnues, median: NaN, p90: NaN, p99: NaN, max: NaN };
    }
    valeurs.sort((a, b) => a - b);
    const at = (f) => valeurs[Math.min(valeurs.length - 1, Math.floor(f * valeurs.length))];
    return {
      count: valeurs.length,
      total,
      unknown: inconnues,
      median: at(0.5),
      p90: at(0.9),
      p99: at(0.99),
      max: valeurs[valeurs.length - 1],
    };
  }
}

/**
 * Va chercher un raster sur l'emprise demandée.
 *
 * `origin` translate le repère : la grille vit en coordonnées de scène comme
 * les points, mais le WMS ne connaît que le Lambert-93 absolu.
 *
 * Rend `null` plutôt que de lever quand la zone n'est pas couverte : le
 * programme LiDAR HD est en cours, et une dalle de points peut exister avant
 * ses rasters. L'appelant doit alors le dire, pas faire comme si.
 *
 * `cache` est transmis tel quel à `fetch`, et il n'est pas décoratif : le
 * service assortit ses **réponses d'erreur** d'un `Cache-Control: private,
 * max-age=1814400`, soit vingt et un jours. Une panne d'une seconde côté
 * serveur reste donc figée trois semaines dans le cache du navigateur, et
 * redemander la même URL ne fait que relire l'erreur. Mesuré : `LayerNotDefined`
 * servi trois fois de suite sur une couche qui existe, tandis que la même
 * requête sur une emprise décalée de 7 m répondait normalement. Une reprise
 * n'a de sens qu'en forçant la revalidation.
 */
export async function fetchRaster({
  produit = 'mnt',
  center = [0, 0],
  size,
  cells,
  origin,
  minCoverage = 0.5,
  cache,
  fetchImpl,
  signal,
} = {}) {
  const p = PRODUITS[produit];
  if (!p) throw new Error(`produit inconnu : ${produit}`);
  const doFetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const bbox = [
    center[0] + origin[0] - size / 2,
    center[1] + origin[1] - size / 2,
    center[0] + origin[0] + size / 2,
    center[1] + origin[1] + size / 2,
  ];
  const reponse = await doFetch(rasterUrl({ bbox, pixels: cells, produit }), { signal, cache });
  if (!reponse.ok) throw new Error(`${p.libelle} : HTTP ${reponse.status}`);

  // Une erreur WMS arrive en XML avec un code 200 : c'est la taille qui la
  // trahit, un rapport d'erreur ne pesant jamais les 4 Mo attendus.
  const buffer = await reponse.arrayBuffer();
  if (buffer.byteLength !== cells * cells * 4) {
    const debut = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(400, buffer.byteLength)));
    throw new Error(`${p.libelle} : réponse inattendue (${buffer.byteLength} o) — ${debut.slice(0, 200)}`);
  }

  const { height, known, observed } = decodeBil(buffer, cells);
  if (observed / (cells * cells) < minCoverage) return null;
  // La grille vit en repère de scène, comme les points : même translation
  // planimétrique, et même retrait de l'altitude d'origine — mais seulement
  // pour les produits qui portent une altitude.
  return new RasterGrid({
    center, size, cells, height, known, observed, produit,
    zOffset: p.altitude ? -origin[2] : 0,
  });
}
