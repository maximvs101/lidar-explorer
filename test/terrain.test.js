import { describe, expect, it } from 'vitest';
import { GROUND_CODES, TerrainGrid, heightStats } from '../src/analysis/terrain.js';

/** Sème des points sur une pente régulière : z = a·x + b·y + c. */
function pente(grid, { a = 0.05, b = 0, c = 100, pas = 4, classe = 2, zone = null } = {}) {
  const pos = [];
  const cls = [];
  const demi = grid.size / 2;
  for (let x = -demi + 1; x < demi; x += pas) {
    for (let y = -demi + 1; y < demi; y += pas) {
      if (zone && !zone(x, y)) continue;
      pos.push(grid.center[0] + x, grid.center[1] + y, a * x + b * y + c);
      cls.push(classe);
    }
  }
  return { positions: Float32Array.from(pos), classification: Uint8Array.from(cls) };
}

describe('TerrainGrid — construction', () => {
  it('refuse une géométrie absurde', () => {
    expect(() => new TerrainGrid({ size: 0 })).toThrow(/size/);
    expect(() => new TerrainGrid({ cells: 1 })).toThrow(/cells/);
    expect(() => new TerrainGrid({ cells: 12.5 })).toThrow(/entier/);
  });

  it('situe les points dans la bonne cellule et rejette le hors-zone', () => {
    const g = new TerrainGrid({ center: [1000, 2000], size: 100, cells: 10 });
    expect(g.index(1000, 2000)).toBe(5 * 10 + 5); // le centre
    expect(g.index(955, 1955)).toBe(0); // coin bas-gauche
    expect(g.index(1060, 2000)).toBe(-1); // hors zone
    expect(g.index(1000, 1940)).toBe(-1);
  });

  it('restitue une pente connue là où elle a été observée', () => {
    const g = new TerrainGrid({ center: [0, 0], size: 200, cells: 50 });
    const { positions, classification } = pente(g, { a: 0.05, c: 100, pas: 2 });
    expect(g.addPoints(positions, classification)).toBeGreaterThan(0);
    g.build();

    // z = 0,05·x + 100 : à x = +40 on attend 102, à x = -40 on attend 98.
    expect(g.heightAt(40, 0)).toBeCloseTo(102, 0);
    expect(g.heightAt(-40, 0)).toBeCloseTo(98, 0);
    expect(g.coverage()).toBeGreaterThan(0.9);
  });

  it('ne retient que les classes de sol', () => {
    const g = new TerrainGrid({ center: [0, 0], size: 100, cells: 20 });
    const veg = pente(g, { classe: 5, c: 130 });
    expect(g.addPoints(veg.positions, veg.classification)).toBe(0);
    g.build();
    expect(Number.isNaN(g.heightAt(0, 0))).toBe(true);
  });
});

describe('TerrainGrid — trous', () => {
  it('comble un trou par diffusion, en restant proche de la pente réelle', () => {
    // Une clairière inversée : pas de sol au centre, comme sous un couvert dense.
    const g = new TerrainGrid({ center: [0, 0], size: 200, cells: 50 });
    const dehors = (x, y) => Math.hypot(x, y) > 30;
    const { positions, classification } = pente(g, { a: 0.05, c: 100, pas: 2, zone: dehors });
    g.addPoints(positions, classification);

    const observee = g.coverage();
    const bilan = g.build();

    expect(observee).toBeLessThan(0.95); // il manquait bien quelque chose
    expect(bilan.restants).toBe(0); // tout a été comblé
    expect(bilan.passes).toBeGreaterThan(0);
    // Au centre du trou, la diffusion doit rester dans le bon ordre de grandeur.
    expect(g.heightAt(0, 0)).toBeGreaterThan(95);
    expect(g.heightAt(0, 0)).toBeLessThan(105);
  });

  it('laisse inconnu ce qu’aucun voisin ne peut renseigner', () => {
    // Grille entièrement vide : rien à propager, donc rien ne doit être inventé.
    const g = new TerrainGrid({ center: [0, 0], size: 100, cells: 10 });
    const bilan = g.build();
    expect(bilan.observed).toBe(0);
    expect(bilan.restants).toBe(100);
    expect(Number.isNaN(g.heightAt(0, 0))).toBe(true);
  });

  it('mesure la couverture réelle, avant tout comblement', () => {
    // C'est ce chiffre qui qualifie la confiance : après comblement, la grille
    // est pleine et ne dit plus rien de ce qui a été observé.
    const g = new TerrainGrid({ center: [0, 0], size: 200, cells: 40 });
    const quart = (x, y) => x > 0 && y > 0;
    const { positions, classification } = pente(g, { pas: 2, zone: quart });
    g.addPoints(positions, classification);
    const avant = g.coverage();
    g.build();
    expect(avant).toBeGreaterThan(0.2);
    expect(avant).toBeLessThan(0.3); // un quart environ
    expect(g.coverage()).toBeCloseTo(avant, 5); // le comblement ne la gonfle pas
  });
});

describe('hauteur au-dessus du sol', () => {
  it('rend la hauteur relative, pas l’altitude', () => {
    const g = new TerrainGrid({ center: [0, 0], size: 200, cells: 50 });
    const sol = pente(g, { a: 0.05, c: 100, pas: 2 });
    g.addPoints(sol.positions, sol.classification);
    g.build();

    // Deux arbres de 20 m, l'un en bas de pente, l'autre en haut : même hauteur
    // malgré 4 m d'écart d'altitude.
    expect(g.aboveGround(-40, 0, 98 + 20)).toBeCloseTo(20, 0);
    expect(g.aboveGround(40, 0, 102 + 20)).toBeCloseTo(20, 0);
  });

  it('rend NaN là où le terrain est inconnu, plutôt qu’un chiffre faux', () => {
    const g = new TerrainGrid({ center: [0, 0], size: 100, cells: 10 });
    expect(Number.isNaN(g.aboveGround(0, 0, 150))).toBe(true);
    expect(Number.isNaN(g.heightAt(500, 500))).toBe(true);
  });
});

describe('heightStats', () => {
  it('résume la canopée sans se laisser fixer par un point aberrant', () => {
    const g = new TerrainGrid({ center: [0, 0], size: 200, cells: 50 });
    const sol = pente(g, { a: 0, c: 100, pas: 2 });
    g.addPoints(sol.positions, sol.classification);
    g.build();

    const pos = [];
    const cls = [];
    for (let i = 0; i < 500; i += 1) { pos.push(0, 0, 100 + 20); cls.push(5); }
    pos.push(0, 0, 100 + 300); cls.push(5); // un point manifestement faux
    const s = heightStats(g, Float32Array.from(pos), Uint8Array.from(cls), new Set([5]));

    expect(s.count).toBe(501);
    expect(s.max).toBeCloseTo(300, 0); // le maximum brut suit l'aberration
    expect(s.median).toBeCloseTo(20, 0); // la médiane, non
    expect(s.p99).toBeLessThan(100); // le centile non plus
  });

  it('compte les points dont le sol est inconnu', () => {
    const g = new TerrainGrid({ center: [0, 0], size: 100, cells: 10 });
    const s = heightStats(g, Float32Array.from([0, 0, 120]), Uint8Array.from([5]), new Set([5]));
    expect(s.count).toBe(0);
    expect(s.unknown).toBe(1);
    expect(Number.isNaN(s.max)).toBe(true);
  });

  it('ignore les classes non demandées', () => {
    const g = new TerrainGrid({ center: [0, 0], size: 200, cells: 50 });
    const sol = pente(g, { a: 0, c: 100, pas: 2 });
    g.addPoints(sol.positions, sol.classification);
    g.build();
    const s = heightStats(g, Float32Array.from([0, 0, 110]), Uint8Array.from([6]), new Set([5]));
    expect(s.count).toBe(0);
    expect(s.unknown).toBe(0);
  });
});

describe('GROUND_CODES', () => {
  it('ne contient que le sol ASPRS', () => {
    expect(GROUND_CODES.has(2)).toBe(true);
    for (const autre of [1, 3, 4, 5, 6, 9, 17, 64]) expect(GROUND_CODES.has(autre)).toBe(false);
  });
});

describe('couverture restreinte', () => {
  it('ne juge que la zone demandée, pas la grille entière', () => {
    // Sol présent dans un seul coin : la couverture globale est faible, celle
    // du coin est élevée. Confondre les deux ferait passer une grille à peine
    // chargée pour une zone mal observée.
    const g = new TerrainGrid({ center: [0, 0], size: 400, cells: 40 });
    const pos = [];
    const cls = [];
    for (let x = -190; x < -110; x += 5) {
      for (let y = -190; y < -110; y += 5) { pos.push(x, y, 100); cls.push(2); }
    }
    g.addPoints(Float32Array.from(pos), Uint8Array.from(cls));

    const globale = g.coverage();
    const dansLeCoin = g.coverageWithin([-150, -150], 60);
    const ailleurs = g.coverageWithin([150, 150], 60);

    expect(globale).toBeLessThan(0.15);
    expect(dansLeCoin.ratio).toBeGreaterThan(0.9);
    expect(ailleurs.ratio).toBe(0);
    expect(dansLeCoin.total).toBeGreaterThan(0);
  });

  it('rend NaN pour une zone entièrement hors grille', () => {
    const g = new TerrainGrid({ center: [0, 0], size: 100, cells: 10 });
    expect(Number.isNaN(g.coverageWithin([5000, 5000], 50).ratio)).toBe(true);
  });

  it('borne la zone aux limites de la grille', () => {
    const g = new TerrainGrid({ center: [0, 0], size: 100, cells: 10 });
    const r = g.coverageWithin([0, 0], 10_000);
    expect(r.total).toBe(100); // toute la grille, pas davantage
  });
});
