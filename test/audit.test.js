import { describe, expect, it } from 'vitest';
import { TerrainGrid } from '../src/analysis/terrain.js';
import {
  TOLERANCES,
  VEGETATION_STRATA,
  WaterPlanarity,
  classContradictions,
  summarise,
} from '../src/analysis/audit.js';

/** Terrain plat à l'altitude 100, entièrement observé. */
function terrainPlat(size = 200, cells = 40, z = 100) {
  const g = new TerrainGrid({ center: [0, 0], size, cells });
  const pos = [];
  const cls = [];
  const demi = size / 2;
  for (let x = -demi + 1; x < demi; x += 2) {
    for (let y = -demi + 1; y < demi; y += 2) { pos.push(x, y, z); cls.push(2); }
  }
  g.addPoints(Float32Array.from(pos), Uint8Array.from(cls));
  g.build();
  return g;
}

function lot(points) {
  const pos = [];
  const cls = [];
  for (const [x, y, z, c] of points) { pos.push(x, y, z); cls.push(c); }
  return { positions: Float32Array.from(pos), classification: Uint8Array.from(cls) };
}

describe('contradictions de classe', () => {
  it('repère la végétation haute posée au sol', () => {
    // Classe 5 = au-dessus de 1,5 m par définition. À 0,2 m, le point contredit
    // sa propre classe : ce n'est pas une appréciation, c'est la nomenclature.
    const g = terrainPlat();
    const { positions, classification } = lot([
      [0, 0, 100.2, 5], // contredit
      [2, 2, 100.3, 5], // contredit
      [4, 4, 120, 5], // 20 m, normal
      [6, 6, 100.1, 3], // végétation basse au sol : normal
    ]);
    const r = classContradictions(g, positions, classification);
    expect(r.vegetationTropBasse).toBe(2);
    expect(r.testes).toBe(4);
  });

  it('tolère la marge avant de crier à la faute', () => {
    const g = terrainPlat();
    // 1,5 - 0,5 = 1,0 m : à 1,1 m on est dans la marge, à 0,9 m on n'y est plus.
    const dans = lot([[0, 0, 101.1, 5]]);
    const dehors = lot([[0, 0, 100.9, 5]]);
    expect(classContradictions(g, dans.positions, dans.classification).vegetationTropBasse).toBe(0);
    expect(classContradictions(g, dehors.positions, dehors.classification).vegetationTropBasse).toBe(1);
  });

  it('repère le bâtiment enterré, et pas celui qui affleure', () => {
    const g = terrainPlat();
    const { positions, classification } = lot([
      [0, 0, 96, 6], // 4 m sous le sol : incohérent
      [2, 2, 99.5, 6], // 50 cm sous : dans la marge, un dallage suffit
      [4, 4, 112, 6], // un toit, normal
    ]);
    const r = classContradictions(g, positions, classification);
    expect(r.batimentSousSol).toBe(1);
  });

  it('ne juge pas là où le sol est inconnu', () => {
    // Sans terrain observé, la hauteur est une estimation : lui reprocher une
    // contradiction reviendrait à sanctionner notre propre interpolation.
    const vide = new TerrainGrid({ center: [0, 0], size: 100, cells: 10 });
    vide.build();
    const { positions, classification } = lot([[0, 0, 100.2, 5], [2, 2, 96, 6]]);
    const r = classContradictions(vide, positions, classification);
    expect(r.testes).toBe(0);
    expect(r.sansSol).toBe(2);
    expect(r.vegetationTropBasse).toBe(0);
    expect(r.batimentSousSol).toBe(0);
  });

  it('ignore les classes sans définition de hauteur', () => {
    const g = terrainPlat();
    const { positions, classification } = lot([[0, 0, 100, 2], [2, 2, 100, 9], [4, 4, 100, 17]]);
    const r = classContradictions(g, positions, classification);
    expect(r.testes).toBe(0);
  });

  it('cumule sur plusieurs lots', () => {
    const g = terrainPlat();
    const a = lot([[0, 0, 100.2, 5]]);
    const b = lot([[2, 2, 100.1, 5]]);
    const bilan = classContradictions(g, a.positions, a.classification);
    classContradictions(g, b.positions, b.classification, bilan);
    expect(bilan.vegetationTropBasse).toBe(2);
    expect(bilan.testes).toBe(2);
  });
});

describe('planéité de l’eau', () => {
  function nappe(z = 100, bruit = 0, n = 40, x0 = 0) {
    const pts = [];
    for (let i = 0; i < n; i += 1) {
      pts.push([x0 + (i % 8) * 2, Math.floor(i / 8) * 2, z + (i % 2 ? bruit : -bruit), 9]);
    }
    return lot(pts);
  }

  it('accepte une nappe horizontale', () => {
    const w = new WaterPlanarity({ cell: 20 });
    const { positions, classification } = nappe(100, 0.02);
    expect(w.addPoints(positions, classification)).toBe(40);
    const r = w.report();
    expect(r.retenues).toBe(1);
    expect(r.suspectes).toBe(0);
    expect(r.etendueMax).toBeLessThan(0.1);
  });

  it('signale une « eau » qui monte et descend', () => {
    // Une surface d'eau libre est horizontale : 3 m d'écart dans une maille de
    // 20 m ne peut pas être de l'eau. C'est le seul cas où l'on peut écrire
    // « faux » sans référence extérieure.
    const w = new WaterPlanarity({ cell: 20 });
    const { positions, classification } = nappe(100, 1.5);
    w.addPoints(positions, classification);
    const r = w.report();
    expect(r.suspectes).toBe(1);
    expect(r.ratio).toBe(1);
    expect(r.etendueMax).toBeCloseTo(3, 1);
  });

  it('ne conclut pas sur une cellule trop peu peuplée', () => {
    const w = new WaterPlanarity({ cell: 20 });
    const { positions, classification } = nappe(100, 5, 4);
    w.addPoints(positions, classification);
    const r = w.report();
    expect(r.cellules).toBe(1);
    expect(r.retenues).toBe(0); // sous le seuil de points
    expect(Number.isNaN(r.ratio)).toBe(true);
  });

  it('sépare bien les cellules voisines', () => {
    const w = new WaterPlanarity({ cell: 20 });
    const plate = nappe(100, 0.01, 40, 0);
    const cassee = nappe(100, 2, 40, 100); // 100 m plus loin : autre cellule
    w.addPoints(plate.positions, plate.classification);
    w.addPoints(cassee.positions, cassee.classification);
    const r = w.report();
    expect(r.retenues).toBe(2);
    expect(r.suspectes).toBe(1);
    expect(r.ratio).toBeCloseTo(0.5);
  });

  it('n’écoute que la classe eau', () => {
    const w = new WaterPlanarity({ cell: 20 });
    const pts = [];
    for (let i = 0; i < 40; i += 1) pts.push([i % 8, Math.floor(i / 8), 100 + i, 2]);
    const { positions, classification } = lot(pts);
    expect(w.addPoints(positions, classification)).toBe(0);
    expect(w.report().retenues).toBe(0);
  });

  it('refuse une maille absurde', () => {
    expect(() => new WaterPlanarity({ cell: 0 })).toThrow(/cell/);
  });
});

describe('résumé', () => {
  it('rapporte chaque anomalie à ce qui a été testé', () => {
    const s = summarise(
      { testes: 1000, sansSol: 12, vegetationTropBasse: 30, batimentSousSol: 5, solEnLair: 0 },
      { retenues: 4, suspectes: 1 },
    );
    expect(s.vegetation.share).toBeCloseTo(3);
    expect(s.batiment.share).toBeCloseTo(0.5);
    expect(s.sansSol).toBe(12);
  });

  it('ne divise pas par zéro quand rien n’a pu être testé', () => {
    const s = summarise(
      { testes: 0, sansSol: 40, vegetationTropBasse: 0, batimentSousSol: 0, solEnLair: 0 },
      {},
    );
    expect(Number.isFinite(s.vegetation.share)).toBe(true);
    expect(s.vegetation.share).toBe(0);
  });
});

describe('constantes', () => {
  it('décrivent les strates dans le bon ordre, sans trou', () => {
    expect(VEGETATION_STRATA[3].max).toBe(VEGETATION_STRATA[4].min);
    expect(VEGETATION_STRATA[4].max).toBe(VEGETATION_STRATA[5].min);
    expect(VEGETATION_STRATA[5].max).toBe(Infinity);
  });

  it('gardent des tolérances positives', () => {
    for (const [nom, v] of Object.entries(TOLERANCES)) {
      expect(v, nom).toBeGreaterThan(0);
    }
  });
});
