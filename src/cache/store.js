/**
 * Cache des nœuds COPC, sur IndexedDB.
 *
 * On stocke les octets **compressés** tels que reçus, pas les points décodés :
 * c'est 40 % plus compact (14 Mo contre 22 Mo pour les niveaux 0-2 d'une dalle),
 * le décodage ne coûte que 0,9 s, et surtout le cache reste valide si l'on
 * change plus tard ce qu'on extrait des points (ajouter l'intensité, l'angle…).
 *
 * IndexedDB peut être absent ou refuser d'écrire — navigation privée, quota,
 * réglages bloquant le stockage de site. Ce n'est jamais une raison d'échouer :
 * `open()` rend alors un cache inerte et l'application continue en réseau seul.
 */

const DB_NAME = 'lidar-explorer';
const STORE = 'nodes';
const DB_VERSION = 1;

/** Cache inerte : accepte tout, ne retient rien. */
export class NullCache {
  constructor(reason = 'non disponible') {
    this.available = false;
    this.reason = reason;
  }
  async get() {
    return undefined;
  }
  async put() {}
  async count() {
    return 0;
  }
  async clear() {}
}

export class NodeCache {
  constructor(db) {
    this.db = db;
    this.available = true;
  }

  static async open() {
    if (typeof indexedDB === 'undefined') return new NullCache("pas d'indexedDB");
    try {
      const db = await new Promise((resolve, reject) => {
        const rq = indexedDB.open(DB_NAME, DB_VERSION);
        rq.onupgradeneeded = () => {
          if (!rq.result.objectStoreNames.contains(STORE)) rq.result.createObjectStore(STORE);
        };
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => reject(rq.error);
        rq.onblocked = () => reject(new Error('ouverture bloquée par un autre onglet'));
      });
      return new NodeCache(db);
    } catch (e) {
      return new NullCache(e?.message ?? String(e));
    }
  }

  _tx(mode) {
    return this.db.transaction(STORE, mode).objectStore(STORE);
  }

  async get(key) {
    try {
      const value = await promisify(this._tx('readonly').get(key));
      return value ? new Uint8Array(value) : undefined;
    } catch {
      return undefined; // un cache illisible se comporte comme un cache vide
    }
  }

  async put(key, bytes) {
    try {
      // On recopie dans un ArrayBuffer propre : le tampon d'origine peut être
      // une vue sur une zone plus large, qui serait alors stockée en entier.
      const copy = bytes.slice();
      await promisify(this._tx('readwrite').put(copy.buffer, key));
    } catch {
      // Quota atteint ou écriture refusée : le réseau reste la source de vérité.
    }
  }

  async count() {
    try {
      return await promisify(this._tx('readonly').count());
    } catch {
      return 0;
    }
  }

  async clear() {
    try {
      await promisify(this._tx('readwrite').clear());
    } catch {
      /* rien à faire */
    }
  }
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Clé stable d'un nœud : l'URL de la dalle plus sa position dans l'octree. */
export function cacheKey(url, nodeIdentifier) {
  return `${url}#${nodeIdentifier}`;
}
