import { describe, expect, it } from 'vitest';
import {
  className,
  histogram,
  isDescendant,
  maxDivergence,
  shares,
  subtreeByLevel,
  totalOf,
} from '../src/analysis/classStats.js';

describe('histogramme', () => {
  it('compte et cumule sur plusieurs lots', () => {
    const h = histogram(Uint8Array.from([2, 2, 6, 5]));
    histogram(Uint8Array.from([2, 9]), h);
    expect(h.get(2)).toBe(3);
    expect(h.get(6)).toBe(1);
    expect(h.get(9)).toBe(1);
    expect(totalOf(h)).toBe(6);
  });

  it('rend des parts triées qui totalisent 100', () => {
    const s = shares(histogram(Uint8Array.from([2, 2, 2, 6])));
    expect(s[0]).toMatchObject({ code: 2, count: 3 });
    expect(s[0].share).toBeCloseTo(75);
    expect(s.reduce((a, x) => a + x.share, 0)).toBeCloseTo(100);
  });

  it('ne divise pas par zéro sur un lot vide', () => {
    expect(shares(new Map())).toEqual([]);
    expect(totalOf(new Map())).toBe(0);
  });

  it('ne produit pas de NaN sur un histogramme peuplé de zéros', () => {
    // Une Map vide n'éprouve pas la garde : la boucle ne tourne pas et le
    // résultat est [] de toute façon. Il faut des entrées dont le total est nul
    // pour que la division ait réellement lieu.
    const creux = new Map([
      [2, 0],
      [6, 0],
    ]);
    expect(totalOf(creux)).toBe(0);
    const s = shares(creux);
    expect(s).toEqual([]);
    for (const row of s) expect(Number.isNaN(row.share)).toBe(false);
  });

  it('nomme les classes connues et laisse les autres lisibles', () => {
    expect(className(6)).toBe('bâtiment');
    expect(className(64)).toBe('sursol pérenne');
    expect(className(200)).toBe('classe 200');
  });
});

describe('parenté dans l’octree', () => {
  it('reconnaît un descendant par décalage des indices', () => {
    const ancestor = { level: 2, x: 2, y: 1, z: 0 };
    expect(isDescendant(ancestor, { level: 3, x: 5, y: 2, z: 1 })).toBe(true);
    expect(isDescendant(ancestor, { level: 3, x: 4, y: 3, z: 0 })).toBe(true);
    expect(isDescendant(ancestor, { level: 3, x: 6, y: 2, z: 0 })).toBe(false);
    expect(isDescendant(ancestor, { level: 4, x: 11, y: 5, z: 1 })).toBe(true);
  });

  it('se considère comme son propre ancêtre, et jamais l’inverse', () => {
    const k = { level: 2, x: 2, y: 1, z: 0 };
    expect(isDescendant(k, k)).toBe(true);
    expect(isDescendant({ level: 3, x: 5, y: 2, z: 1 }, k)).toBe(false);
  });

  it('refuse un nœud plus haut dans l’arbre, même à indices identiques', () => {
    // Cas qui éprouve réellement la garde sur les niveaux. Sans elle, le
    // décalage devient négatif ; en JavaScript `>>` prend son opérande modulo
    // 32, donc `0 >> -1` vaut `0 >> 31`, c'est-à-dire 0 — et la comparaison
    // réussit par accident. Un ancêtre serait alors pris pour son descendant.
    expect(isDescendant({ level: 3, x: 0, y: 0, z: 0 }, { level: 2, x: 0, y: 0, z: 0 })).toBe(false);
    expect(isDescendant({ level: 5, x: 0, y: 0, z: 0 }, { level: 0, x: 0, y: 0, z: 0 })).toBe(false);
  });

  it('groupe un sous-arbre par niveau sans rien attraper d’étranger', () => {
    const nodes = [
      { key: { level: 2, x: 2, y: 1, z: 0 } },
      { key: { level: 3, x: 5, y: 2, z: 1 } },
      { key: { level: 3, x: 4, y: 3, z: 0 } },
      { key: { level: 3, x: 0, y: 0, z: 0 } }, // ailleurs
      { key: { level: 4, x: 11, y: 5, z: 1 } },
    ];
    const levels = subtreeByLevel(nodes, { level: 2, x: 2, y: 1, z: 0 });
    expect(levels.map((l) => l.level)).toEqual([2, 3, 4]);
    expect(levels[1].nodes).toHaveLength(2);
    expect(levels[2].nodes).toHaveLength(1);
  });
});

describe('divergence', () => {
  it('trouve la classe qui s’écarte le plus', () => {
    const a = shares(histogram(Uint8Array.from([2, 2, 2, 2, 5, 5, 6, 6, 6, 6])));
    const b = shares(histogram(Uint8Array.from([2, 2, 5, 5, 5, 5, 5, 5, 6, 6])));
    const worst = maxDivergence(a, b);
    expect(worst.code).toBe(5); // 20 % contre 60 %
    expect(worst.delta).toBeCloseTo(40);
  });

  it('rend zéro sur deux répartitions identiques', () => {
    const s = shares(histogram(Uint8Array.from([2, 2, 6])));
    expect(maxDivergence(s, s).delta).toBe(0);
  });

  it('compte une classe absente d’un côté comme un écart plein', () => {
    const a = shares(histogram(Uint8Array.from([2, 2, 2, 2])));
    const b = shares(histogram(Uint8Array.from([2, 2, 6, 6])));
    expect(maxDivergence(a, b).delta).toBeCloseTo(50);
  });
});
