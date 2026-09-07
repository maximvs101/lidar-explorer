import { RequestQueue } from './net/queue.js';
import { fetchRange } from './net/range.js';
import { HEADER_PROBE_SIZE, parseCopcHeader, averageDensity } from './copc/header.js';
import { loadHierarchy, summarise } from './copc/hierarchy.js';
import { NodeCache, cacheKey } from './cache/store.js';
import { DecoderPool } from './decode/decoder.js';

/**
 * Socle de chargement d'une dalle COPC : lecture par intervalles, file d'attente
 * bornée, cache persistant, décodage hors du fil principal.
 *
 * Les compteurs sont séparés entre réseau et cache — un total agrégé ne
 * permettrait pas de vérifier qu'un second chargement ne touche plus le réseau.
 */
export class TileLoader {
  constructor({ queue, cache, decoder } = {}) {
    this.queue = queue ?? new RequestQueue({ concurrency: 4 });
    this.cache = cache;
    this.decoder = decoder ?? new DecoderPool(1);
    this.stats = {
      networkRequests: 0,
      networkBytes: 0,
      cacheHits: 0,
      cacheBytes: 0,
      cacheMisses: 0,
    };
  }

  static async create(options = {}) {
    const cache = options.cache ?? (await NodeCache.open());
    return new TileLoader({ ...options, cache });
  }

  /**
   * Lit un intervalle, en passant par le cache si une clé est fournie.
   * Sans clé, la lecture va systématiquement au réseau.
   */
  async _read(url, start, end, key) {
    if (key && this.cache) {
      const hit = await this.cache.get(key);
      if (hit) {
        this.stats.cacheHits += 1;
        this.stats.cacheBytes += hit.length;
        return hit;
      }
      this.stats.cacheMisses += 1;
    }

    const bytes = await this.queue.run(() =>
      fetchRange(url, start, end, {
        onBytes: (n) => {
          this.stats.networkRequests += 1;
          this.stats.networkBytes += n;
        },
      }),
    );

    if (key && this.cache) await this.cache.put(key, bytes);
    return bytes;
  }

  /** Ouvre une dalle : en-tête, VLR COPC, et de quoi situer la scène. */
  async open(url) {
    const bytes = await this._read(url, 0, HEADER_PROBE_SIZE - 1, cacheKey(url, 'header'));
    const header = parseCopcHeader(bytes);
    return {
      url,
      header,
      density: averageDensity(header),
      // Origine locale du rendu : sans elle, les coordonnées Lambert-93 écrites
      // en Float32 seraient quantifiées à ~0,5 m. Voir decode.worker.js.
      origin: header.center,
    };
  }

  /** Charge la hiérarchie de l'octree jusqu'au niveau demandé. */
  async hierarchy(tile, { maxLevel = 2 } = {}) {
    const { nodes, pagesRead } = await loadHierarchy(
      tile.header,
      (offset, size) =>
        this._read(tile.url, offset, offset + size - 1, cacheKey(tile.url, `hier-${offset}-${size}`)),
      { maxLevel },
    );
    return { nodes, pagesRead, levels: summarise(nodes) };
  }

  /**
   * Charge et décode une liste de nœuds. `onNode` est appelé au fil de l'eau
   * pour que l'affichage progresse au lieu d'attendre le dernier octet.
   */
  async loadNodes(tile, nodes, { onNode, origin: sceneOrigin } = {}) {
    const { header } = tile;
    // Avec plusieurs dalles à l'écran, c'est l'origine de la **scène** qu'il
    // faut soustraire, pas celle propre à la dalle : sinon chaque dalle est
    // ramenée à son propre centre et toutes se superposent au même endroit.
    const origin = sceneOrigin ?? tile.origin;
    const results = await Promise.all(
      nodes.map(async (node) => {
        const bytes = await this._read(
          tile.url,
          node.offset,
          node.offset + node.byteSize - 1,
          cacheKey(tile.url, node.id),
        );
        const decoded = await this.decoder.decode({
          bytes,
          pointFormat: header.pointFormat,
          pointLength: header.pointLength,
          pointCount: node.pointCount,
          scale: header.scale,
          offset: header.offset,
          origin,
        });
        const result = { node, ...decoded };
        onNode?.(result);
        return result;
      }),
    );
    return results;
  }

  /** Instantané de tous les compteurs, pour les contrôles de bon fonctionnement. */
  report() {
    return {
      ...this.stats,
      queue: { ...this.queue.stats, concurrency: this.queue.concurrency },
      decode: { ...this.decoder.stats },
      cacheAvailable: this.cache?.available ?? false,
    };
  }

  dispose() {
    this.decoder.terminate();
  }
}
