import { createLazPerf } from 'laz-perf';
import wasmUrl from 'laz-perf/lib/web/laz-perf.wasm?url';

let lazPerf = null;
let scratchPtr = 0;
let scratchSize = 0;
let pointPtr = 0;
let heapRebinds = 0;

async function ensureLazPerf() {
  if (!lazPerf) {
    lazPerf = await createLazPerf({ locateFile: () => wasmUrl });
  }
  return lazPerf;
}

/** Réserve un tampon au moins aussi grand que `size`, réutilisé d'un nœud à l'autre. */
function ensureScratch(L, size) {
  if (size > scratchSize) {
    if (scratchPtr) L._free(scratchPtr);
    scratchPtr = L._malloc(size);
    scratchSize = size;
  }
  return scratchPtr;
}

/**
 * Décode un nœud COPC (un chunk LAZ autonome).
 *
 * Deux pièges se cumulent ici.
 *
 * 1. Toute allocation WASM peut agrandir le heap Emscripten, ce qui **détache**
 *    l'ArrayBuffer et invalide toute vue conservée dessus. On pré-alloue donc les
 *    tampons, et on garde malgré tout une garde : un buffer détaché a
 *    `byteLength === 0`. Sans elle : « Cannot perform DataView.prototype.getInt32
 *    on a detached ArrayBuffer », au milieu du chargement.
 *
 * 2. Les coordonnées sont en Lambert-93, donc autour de 6 277 000 en Y. Un
 *    Float32 n'y offre qu'un pas de ~0,5 m : écrire les coordonnées absolues dans
 *    un Float32Array **quantifie le nuage** sans rien signaler, et un relevé à
 *    20 cm de précision ressort dégradé d'un facteur deux. On soustrait donc une
 *    origine avant la conversion ; ramenées dans ±500 m, les valeurs retrouvent
 *    une précision bien meilleure que le millimètre.
 */
function decodeNode(L, { bytes, pointFormat, pointLength, pointCount, scale, offset, origin }) {
  const chunkPtr = ensureScratch(L, bytes.length);
  if (!pointPtr) pointPtr = L._malloc(pointLength);

  let heap = new DataView(L.HEAPU8.buffer);
  const rebind = () => {
    if (heap.buffer.byteLength === 0) {
      heap = new DataView(L.HEAPU8.buffer);
      heapRebinds += 1;
    }
  };

  rebind();
  L.HEAPU8.set(bytes, chunkPtr);

  const decoder = new L.ChunkDecoder();
  decoder.open(pointFormat, pointLength, chunkPtr);
  rebind();

  const positions = new Float32Array(pointCount * 3);
  const classification = new Uint8Array(pointCount);
  const intensity = new Uint16Array(pointCount);
  // L'octet 14 du format 6 porte deja le numero de retour sur ses 4 bits bas et
  // le nombre total de retours sur les 4 hauts : on le recopie tel quel, le
  // desassemblage se fera au rendu.
  const returns = new Uint8Array(pointCount);
  // Identifiant de bande de vol : plusieurs passes se recouvrent, et c'est ce
  // qui explique une densite trois fois superieure a celle annoncee.
  const source = new Uint16Array(pointCount);

  const [sx, sy, sz] = scale;
  const [ox, oy, oz] = offset;
  const [gx, gy, gz] = origin;

  try {
    for (let i = 0; i < pointCount; i += 1) {
      decoder.getPoint(pointPtr);
      rebind();
      positions[i * 3] = heap.getInt32(pointPtr, true) * sx + ox - gx;
      positions[i * 3 + 1] = heap.getInt32(pointPtr + 4, true) * sy + oy - gy;
      positions[i * 3 + 2] = heap.getInt32(pointPtr + 8, true) * sz + oz - gz;
      intensity[i] = heap.getUint16(pointPtr + 12, true);
      returns[i] = heap.getUint8(pointPtr + 14);
      classification[i] = heap.getUint8(pointPtr + 16);
      source[i] = heap.getUint16(pointPtr + 20, true);
    }
  } finally {
    decoder.delete();
  }

  return { positions, classification, intensity, returns, source };
}

self.onmessage = async (event) => {
  const { id, ...payload } = event.data;
  try {
    const L = await ensureLazPerf();
    const started = performance.now();
    const { positions, classification, intensity, returns, source } = decodeNode(L, payload);
    self.postMessage(
      {
        id,
        ok: true,
        positions,
        classification,
        intensity,
        returns,
        source,
        pointCount: payload.pointCount,
        ms: performance.now() - started,
        heapRebinds,
      },
      [positions.buffer, classification.buffer, intensity.buffer, returns.buffer, source.buffer],
    );
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message ?? String(error) });
  }
};
