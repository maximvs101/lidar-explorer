import { describe, expect, it } from 'vitest';
import { RequestQueue } from '../src/net/queue.js';
import { NetworkError, ProtocolError, RateLimitError } from '../src/net/errors.js';

/** Sommeil instantané : les tests mesurent la logique, pas l'horloge. */
const noSleep = () => Promise.resolve();
const noJitter = () => 1;

/**
 * Fabrique une tâche qui note le nombre de tâches simultanément actives.
 * C'est ce compteur, et non le réglage, qui dit ce que la file fait vraiment.
 */
function makeProbe() {
  const state = { current: 0, max: 0, runs: 0 };
  const task = (work = async () => {}) => async () => {
    state.current += 1;
    state.runs += 1;
    if (state.current > state.max) state.max = state.current;
    try {
      return await work();
    } finally {
      state.current -= 1;
    }
  };
  return { state, task };
}

describe('RequestQueue — plafond de concurrence', () => {
  // Un seul réglage testé ne prouve rien : un compteur bloqué sur une constante,
  // ou une file qui sérialise tout, passerait un test à 4. On balaie donc
  // plusieurs valeurs et on exige que le maximum observé SUIVE le réglage.
  it.each([1, 2, 4, 8])('n exécute jamais plus de %i tâches à la fois', async (concurrency) => {
    const { state, task } = makeProbe();
    const queue = new RequestQueue({ concurrency, sleep: noSleep });
    const tick = () => new Promise((r) => setTimeout(r, 1));

    await queue.all(Array.from({ length: 40 }, () => task(tick)));

    expect(state.runs).toBe(40);
    expect(state.max).toBe(concurrency);
    expect(queue.stats.maxInFlight).toBe(concurrency);
  });

  it('sature réellement le plafond quand il y a de quoi le remplir', async () => {
    // Contre-épreuve du test précédent : si la file sérialisait tout, `max`
    // vaudrait 1 partout et le test ci-dessus ne le verrait que pour concurrency=1.
    const { state, task } = makeProbe();
    const queue = new RequestQueue({ concurrency: 6, sleep: noSleep });
    await queue.all(Array.from({ length: 30 }, () => task(() => new Promise((r) => setTimeout(r, 2)))));
    expect(state.max).toBeGreaterThan(1);
  });
});

describe('RequestQueue — réessais', () => {
  it('réessaie un 429 puis rend le résultat', async () => {
    let attempts = 0;
    const queue = new RequestQueue({ concurrency: 2, sleep: noSleep, random: noJitter });

    const value = await queue.run(async () => {
      attempts += 1;
      if (attempts < 3) throw new RateLimitError('http://exemple');
      return 'ok';
    });

    expect(value).toBe('ok');
    expect(attempts).toBe(3);
    expect(queue.stats.retries).toBe(2);
    expect(queue.stats.rateLimited).toBe(2);
    expect(queue.stats.completed).toBe(1);
  });

  it('réessaie aussi une coupure réseau', async () => {
    let attempts = 0;
    const queue = new RequestQueue({ sleep: noSleep, random: noJitter });
    await queue.run(async () => {
      attempts += 1;
      if (attempts < 2) throw new NetworkError('http://exemple', new Error('coupure'));
      return 1;
    });
    expect(attempts).toBe(2);
  });

  it("ne réessaie PAS une erreur de protocole", async () => {
    // Réessayer une réponse mal formée ne la réparerait pas et masquerait le bug
    // derrière cinq requêtes inutiles.
    let attempts = 0;
    const queue = new RequestQueue({ sleep: noSleep });
    await expect(
      queue.run(async () => {
        attempts += 1;
        throw new ProtocolError('206 attendu');
      }),
    ).rejects.toThrow(/206 attendu/);
    expect(attempts).toBe(1);
    expect(queue.stats.retries).toBe(0);
    expect(queue.stats.failed).toBe(1);
  });

  it('abandonne après maxRetries et propage la dernière erreur', async () => {
    let attempts = 0;
    const queue = new RequestQueue({ maxRetries: 3, sleep: noSleep, random: noJitter });
    await expect(
      queue.run(async () => {
        attempts += 1;
        throw new RateLimitError('http://exemple');
      }),
    ).rejects.toThrow(/429/);
    expect(attempts).toBe(4); // la tentative initiale plus 3 reprises
  });

  it("libère le créneau pendant l'attente d'un réessai", async () => {
    // Un job qui patiente ne doit pas retenir un créneau : sinon une rafale de
    // 429 fige la file entière au lieu de la ralentir, et rien ne le signale.
    const order = [];
    let slept = false;
    const queue = new RequestQueue({
      concurrency: 1,
      sleep: () => new Promise((r) => setTimeout(r, 5)),
      random: noJitter,
    });

    const first = queue.run(async () => {
      order.push('premier');
      if (!slept) {
        slept = true;
        throw new RateLimitError('http://exemple');
      }
      return 'premier-ok';
    });
    const second = queue.run(async () => {
      order.push('second');
      return 'second-ok';
    });

    await Promise.all([first, second]);
    // Le second a démarré pendant que le premier attendait son réessai.
    expect(order).toEqual(['premier', 'second', 'premier']);
  });
});

describe('RequestQueue — garde-fous', () => {
  it('refuse une concurrence absurde', () => {
    expect(() => new RequestQueue({ concurrency: 0 })).toThrow(/>= 1/);
    expect(() => new RequestQueue({ concurrency: 2.5 })).toThrow(/entier/);
  });

  it('croît le délai de recul à chaque tentative', () => {
    const queue = new RequestQueue({ baseDelay: 100, maxDelay: 10000, random: noJitter });
    const delays = [1, 2, 3, 4].map((n) => queue._backoff(n));
    expect(delays).toEqual([100, 200, 400, 800]);
    expect(queue._backoff(20)).toBe(10000); // plafonné
  });
});
