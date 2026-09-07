/**
 * Erreurs réseau distinguées explicitement, pour que la file d'attente sache
 * lesquelles valent un nouvel essai. On ne se fie jamais au type natif de
 * l'exception : un `TypeError` peut aussi bien venir d'un bug de notre code que
 * d'un fetch qui a échoué, et réessayer un bug est le meilleur moyen de le cacher.
 */

/** Le serveur a refusé la requête au titre de son quota (HTTP 429). */
export class RateLimitError extends Error {
  constructor(url) {
    super(`quota dépassé (HTTP 429) sur ${url}`);
    this.name = 'RateLimitError';
    this.status = 429;
  }
}

/** La requête n'a pas abouti (coupure, DNS, CORS…). Transitoire par nature. */
export class NetworkError extends Error {
  constructor(url, cause) {
    super(`échec réseau sur ${url}: ${cause?.message ?? cause}`);
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

/** Le serveur a répondu, mais pas ce qu'on attendait. Ne pas réessayer. */
export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export function isRetriable(err) {
  return err instanceof RateLimitError || err instanceof NetworkError;
}
