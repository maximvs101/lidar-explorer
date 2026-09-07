/**
 * Façade sur un ou plusieurs workers de décodage.
 *
 * Le décodage tourne à ~1,8 M points/s, soit ~0,9 s pour les niveaux 0-2 d'une
 * dalle. Sur le fil principal, c'est autant de temps où l'interface est figée —
 * d'où le worker, même avec un seul exemplaire.
 */
export class DecoderPool {
  constructor(size = 1) {
    this.workers = [];
    this.queue = [];
    this.pending = new Map();
    this.nextId = 1;
    this.stats = { decoded: 0, points: 0, ms: 0, heapRebinds: 0 };

    for (let i = 0; i < size; i += 1) {
      const worker = new Worker(new URL('./decode.worker.js', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (event) => this._onMessage(worker, event.data);
      worker.onerror = (event) => this._onFatal(worker, event);
      worker.busy = false;
      this.workers.push(worker);
    }
  }

  decode(payload) {
    return new Promise((resolve, reject) => {
      this.queue.push({ payload, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    for (const worker of this.workers) {
      if (worker.busy || this.queue.length === 0) continue;
      const job = this.queue.shift();
      const id = this.nextId++;
      worker.busy = true;
      this.pending.set(id, { job, worker });
      // Le tampon compressé est transféré : il n'est plus utilisable ici, mais
      // il vient soit du réseau soit du cache, jamais d'un état partagé.
      worker.postMessage({ id, ...job.payload }, [job.payload.bytes.buffer]);
    }
  }

  _onMessage(worker, data) {
    const entry = this.pending.get(data.id);
    if (!entry) return;
    this.pending.delete(data.id);
    worker.busy = false;

    if (data.ok) {
      this.stats.decoded += 1;
      this.stats.points += data.pointCount;
      this.stats.ms += data.ms;
      this.stats.heapRebinds = data.heapRebinds;
      entry.job.resolve(data);
    } else {
      entry.job.reject(new Error(`décodage échoué: ${data.error}`));
    }
    this._pump();
  }

  _onFatal(worker, event) {
    const error = new Error(`worker de décodage en erreur: ${event.message ?? 'cause inconnue'}`);
    for (const [id, entry] of this.pending) {
      if (entry.worker === worker) {
        this.pending.delete(id);
        entry.job.reject(error);
      }
    }
    worker.busy = false;
  }

  terminate() {
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
  }
}
