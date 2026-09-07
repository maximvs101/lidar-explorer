import { isRetriable, RateLimitError } from './errors.js';

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * File d'attente à concurrence bornée, avec réessai et recul exponentiel.
 *
 * Mesuré sur la Géoplateforme IGN (septembre 2026) : jusqu'à 10 requêtes
 * simultanées passent, 12 en font tomber 2, et à 16 **tout** est rejeté en 96 ms —
 * le seau est vidé et plus rien ne passe jusqu'à sa recharge. Aucun en-tête
 * `Retry-After` n'accompagne le 429, le recul est donc entièrement à notre charge.
 *
 * La concurrence par défaut est volontairement basse : la mesure montre qu'au-delà
 * le débit ne suit pas (6 requêtes en parallèle ne vont que 1,8× plus vite que 6
 * en série) alors que le risque de tout perdre d'un coup, lui, augmente.
 *
 * `sleep` et `random` sont injectables pour que les tests s'exécutent sans
 * attendre et sans dépendre du hasard.
 */
export class RequestQueue {
  constructor({
    concurrency = 4,
    maxRetries = 5,
    baseDelay = 250,
    maxDelay = 8000,
    sleep = realSleep,
    random = Math.random,
  } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(`concurrency doit être un entier >= 1, reçu ${concurrency}`);
    }
    this.concurrency = concurrency;
    this.maxRetries = maxRetries;
    this.baseDelay = baseDelay;
    this.maxDelay = maxDelay;
    this.sleep = sleep;
    this.random = random;

    this._pending = [];
    this._inFlight = 0;
    this.stats = {
      started: 0,
      completed: 0,
      failed: 0,
      retries: 0,
      rateLimited: 0,
      maxInFlight: 0,
    };
  }

  /** Empile une tâche (fonction async sans argument) et rend sa promesse. */
  run(task) {
    return new Promise((resolve, reject) => {
      this._pending.push({ task, resolve, reject, attempt: 0 });
      this._pump();
    });
  }

  /** Confort : empile plusieurs tâches et attend qu'elles soient toutes finies. */
  all(tasks) {
    return Promise.all(tasks.map((t) => this.run(t)));
  }

  get inFlight() {
    return this._inFlight;
  }

  get pending() {
    return this._pending.length;
  }

  _pump() {
    while (this._inFlight < this.concurrency && this._pending.length > 0) {
      this._start(this._pending.shift());
    }
  }

  async _start(job) {
    this._inFlight += 1;
    if (this._inFlight > this.stats.maxInFlight) this.stats.maxInFlight = this._inFlight;
    this.stats.started += 1;

    let ok, value, error;
    try {
      value = await job.task();
      ok = true;
    } catch (e) {
      error = e;
      ok = false;
    }

    // Le créneau est rendu ici dans tous les cas — y compris quand on part en
    // réessai : un job qui patiente ne doit pas retenir un créneau, sinon un pic
    // de 429 gèle toute la file au lieu de la ralentir.
    this._inFlight -= 1;

    if (ok) {
      this.stats.completed += 1;
      job.resolve(value);
      this._pump();
      return;
    }

    if (isRetriable(error) && job.attempt < this.maxRetries) {
      if (error instanceof RateLimitError) this.stats.rateLimited += 1;
      this.stats.retries += 1;
      job.attempt += 1;
      const delay = this._backoff(job.attempt);
      this._pump();
      await this.sleep(delay);
      this._pending.push(job);
      this._pump();
      return;
    }

    this.stats.failed += 1;
    job.reject(error);
    this._pump();
  }

  /** Recul exponentiel bruité, pour ne pas resynchroniser tous les clients. */
  _backoff(attempt) {
    const base = Math.min(this.baseDelay * 2 ** (attempt - 1), this.maxDelay);
    return Math.round(base * (0.5 + this.random() * 0.5));
  }
}
