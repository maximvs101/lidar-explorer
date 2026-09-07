import { NetworkError, ProtocolError, RateLimitError } from '../net/errors.js';

import { WFS } from './geoplateforme.js';

const WFS_ENDPOINT = WFS.endpoint;
const LAYER = WFS.layer;

/**
 * Index des dalles LiDAR HD, via le WFS public de la Géoplateforme (sans clé).
 *
 * Point de conduite important : une zone non couverte ne produit **pas** une
 * erreur. Le serveur répond 200 avec `features: []` et `numberMatched: 0`,
 * exactement comme pour un point en pleine mer ou en Guyane. Le service ne sait
 * donc pas distinguer « hors du territoire » de « pas encore livré » — l'interface
 * ne doit pas prétendre le contraire.
 */
export class TileIndex {
  constructor({ endpoint = WFS_ENDPOINT, layer = LAYER, fetchImpl } = {}) {
    this.endpoint = endpoint;
    this.layer = layer;
    // `fetch` doit rester lié à son objet global : rangé tel quel dans un champ
    // puis appelé en `this.fetchImpl(...)`, il reçoit l'instance comme `this` et
    // le navigateur refuse l'appel (« Illegal invocation »).
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.stats = { queries: 0 };
  }

  _url(bbox, count) {
    const params = new URLSearchParams({
      SERVICE: 'WFS',
      VERSION: '2.0.0',
      REQUEST: 'GetFeature',
      TYPENAMES: this.layer,
      OUTPUTFORMAT: 'application/json',
      SRSNAME: 'EPSG:2154',
      COUNT: String(count),
      BBOX: `${bbox.minX},${bbox.minY},${bbox.maxX},${bbox.maxY},EPSG:2154`,
    });
    return `${this.endpoint}?${params}`;
  }

  async _query(bbox, count) {
    let response;
    try {
      response = await this.fetchImpl(this._url(bbox, count));
    } catch (cause) {
      throw new NetworkError(this.endpoint, cause);
    }
    if (response.status === 429) throw new RateLimitError(this.endpoint);
    if (!response.ok) throw new ProtocolError(`WFS: HTTP ${response.status}`);

    let json;
    try {
      json = await response.json();
    } catch (cause) {
      throw new ProtocolError(`WFS: réponse illisible (${cause.message})`);
    }
    if (!json || !Array.isArray(json.features)) {
      throw new ProtocolError('WFS: réponse sans tableau "features"');
    }
    this.stats.queries += 1;
    return json;
  }

  /**
   * Combien de dalles couvrent cette emprise, sans en rapatrier le détail.
   * `numberMatched` est renseigné même avec COUNT=1 : c'est ce qui permet de
   * savoir qu'une vue contient 144 dalles avant de décider de les dessiner.
   */
  async count(bbox) {
    const json = await this._query(bbox, 1);
    return json.numberMatched ?? json.totalFeatures ?? json.features.length;
  }

  /** Dalles intersectant l'emprise, dans la limite de `limit`. */
  async findIn(bbox, { limit = 200 } = {}) {
    const json = await this._query(bbox, limit);
    return {
      tiles: json.features.map(parseTileFeature).filter(Boolean),
      matched: json.numberMatched ?? json.features.length,
      truncated: (json.numberMatched ?? 0) > limit,
    };
  }

  /**
   * Dalle contenant ce point, ou `null` si la zone n'est pas couverte.
   * Un point posé sur une limite peut en renvoyer plusieurs : on retient celle
   * qui contient réellement le point plutôt que la première venue.
   */
  async findAt(x, y) {
    const bbox = { minX: x - 0.5, minY: y - 0.5, maxX: x + 0.5, maxY: y + 0.5 };
    const { tiles } = await this.findIn(bbox, { limit: 8 });
    if (tiles.length === 0) return null;
    return tiles.find((t) => contains(t.bounds, x, y)) ?? tiles[0];
  }
}

export function contains(bounds, x, y) {
  return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
}

/** Emprise d'une géométrie GeoJSON, quelle que soit sa profondeur d'imbrication. */
function geometryBounds(geometry) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (coords) => {
    if (typeof coords[0] === 'number') {
      const [x, y] = coords;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      return;
    }
    for (const c of coords) walk(c);
  };
  if (!geometry?.coordinates) return null;
  walk(geometry.coordinates);
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/**
 * Convertit une entité WFS en descripteur de dalle.
 *
 * Deux précautions :
 *  - `metadata` arrive comme une **chaîne** de JSON, pas comme un objet ; et
 *    elle peut manquer. Une métadonnée absente ne doit jamais empêcher de
 *    charger la dalle, qui est parfaitement utilisable sans.
 *  - `name` et l'URL ne coïncident pas (`..._PTS_C_...` contre `..._PTS_...`).
 *    On utilise donc l'URL telle qu'elle est fournie, sans jamais la reconstruire
 *    à partir du nom.
 */
export function parseTileFeature(feature) {
  const p = feature?.properties;
  if (!p?.url) return null;
  const bounds = geometryBounds(feature.geometry);
  if (!bounds) return null;

  let meta = {};
  try {
    if (typeof p.metadata === 'string' && p.metadata.length > 0) meta = JSON.parse(p.metadata);
    else if (p.metadata && typeof p.metadata === 'object') meta = p.metadata;
  } catch {
    meta = {}; // métadonnée illisible : la dalle reste chargeable
  }

  return {
    id: p.id ?? feature.id ?? null,
    name: p.name ?? null,
    url: p.url,
    format: p.format ?? null,
    bounds,
    acquisition: {
      start: meta.date_debut_acquisition ?? null,
      end: meta.date_fin_acquisition ?? null,
      edition: meta.date_edition ?? null,
      sensor: Array.isArray(meta.capteur) ? meta.capteur.join(', ') : (meta.capteur ?? null),
      classifier: meta.procede_classement ?? null,
      operator: meta.moe_acquisition ?? null,
      mission: meta.code_mission ?? null,
      verticalDatum: meta.systeme_altimetrique ?? null,
    },
    // Volontairement séparé du compte réel du fichier : le WFS annonce ici
    // 31 417 300 points là où l'en-tête COPC en déclare 31 416 352. L'écart de
    // 948 interdit d'utiliser cette valeur pour contrôler un décodage.
    announcedPointCount: meta.nombre_points ?? null,
  };
}

/**
 * Mois d'acquisition, quand il est connu. La saison décide de l'aspect de la
 * végétation : un relevé feuilles tombées ne montre pas la même canopée qu'un
 * relevé en juin, et rien dans le nuage ne le rappelle.
 */
export function acquisitionSeason(acquisition) {
  const date = acquisition?.start ?? acquisition?.end;
  if (!date) return null;
  const month = Number(date.slice(5, 7));
  if (!month) return null;
  if (month >= 5 && month <= 9) return 'végétation en feuilles';
  if (month === 4 || month === 10) return 'végétation intermédiaire';
  return 'végétation sans feuilles';
}
