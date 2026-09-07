import { NetworkError, ProtocolError, RateLimitError } from './errors.js';

/**
 * Lit l'intervalle [start, end] (bornes incluses) d'une ressource distante.
 *
 * Un serveur qui ignore l'en-tête `Range` répond 200 avec le fichier entier :
 * c'est 171 Mo au lieu de 2 Ko, sans la moindre erreur. On exige donc un 206
 * strict plutôt que de se contenter d'un statut « pas d'erreur ».
 */
export async function fetchRange(url, start, end, { signal, onBytes } = {}) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new ProtocolError(`intervalle invalide: ${start}-${end}`);
  }

  let response;
  try {
    response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause;
    throw new NetworkError(url, cause);
  }

  if (response.status === 429) throw new RateLimitError(url);
  if (response.status !== 206) {
    throw new ProtocolError(
      `Range non honoré sur ${url}: HTTP ${response.status} (206 attendu ; ` +
        `un 200 signifie que le serveur renverrait la ressource entière)`,
    );
  }

  let buffer;
  try {
    buffer = await response.arrayBuffer();
  } catch (cause) {
    throw new NetworkError(url, cause);
  }

  const expected = end - start + 1;
  if (buffer.byteLength !== expected) {
    throw new ProtocolError(
      `taille inattendue sur ${url}: ${buffer.byteLength} o reçus, ${expected} attendus`,
    );
  }

  onBytes?.(buffer.byteLength);
  return new Uint8Array(buffer);
}
