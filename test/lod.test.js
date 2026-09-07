import { describe, expect, it } from 'vitest';
import { distanceToBox, nodeBounds, nodeSpacing, screenSpaceError } from '../src/lod/octree.js';
import { diffSelection, selectNodes } from '../src/lod/selector.js';

const CENTER = [0, 0, 0];
const HALF = 500;
const SPACING = 6.803;

const VIEW = { position: [0, 0, 800], fovRadians: (50 * Math.PI) / 180, viewportHeight: 900 };

/** Quatre niveaux d'un octant, plus quelques voisins, avec des comptes réalistes. */
function makeNodes() {
  const nodes = [{ id: '0-0-0-0', key: { level: 0, x: 0, y: 0, z: 0 }, pointCount: 41_642 }];
  for (let x = 0; x < 2; x += 1) {
    for (let y = 0; y < 2; y += 1) {
      nodes.push({
        id: `1-${x}-${y}-0`,
        key: { level: 1, x, y, z: 0 },
        pointCount: 97_811,
      });
    }
  }
  for (let x = 0; x < 4; x += 1) {
    nodes.push({ id: `2-${x}-0-0`, key: { level: 2, x, y: 0, z: 0 }, pointCount: 79_694 });
  }
  return nodes;
}

describe('géométrie de l’octree', () => {
  it('découpe la racine en huit au niveau 1', () => {
    const root = nodeBounds({ level: 0, x: 0, y: 0, z: 0 }, CENTER, HALF);
    expect(root.min).toEqual([-500, -500, -500]);
    expect(root.max).toEqual([500, 500, 500]);
    expect(root.size).toBe(1000);

    const child = nodeBounds({ level: 1, x: 1, y: 0, z: 0 }, CENTER, HALF);
    expect(child.size).toBe(500);
    expect(child.min).toEqual([0, -500, -500]);
    expect(child.max).toEqual([500, 0, 0]);
  });

  it('divise l’espacement par deux à chaque niveau', () => {
    expect(nodeSpacing(6.8, 0)).toBeCloseTo(6.8);
    expect(nodeSpacing(6.8, 1)).toBeCloseTo(3.4);
    expect(nodeSpacing(6.8, 5)).toBeCloseTo(0.2125);
  });

  it('mesure la distance au bord de la boîte, nulle à l’intérieur', () => {
    const b = { min: [0, 0, 0], max: [10, 10, 10] };
    expect(distanceToBox(b, [5, 5, 5])).toBe(0);
    expect(distanceToBox(b, [15, 5, 5])).toBeCloseTo(5);
    expect(distanceToBox(b, [13, 14, 5])).toBeCloseTo(5); // 3-4-5
  });

  it('fait décroître l’erreur écran avec la distance, et croître avec la hauteur', () => {
    const base = { spacing: SPACING, level: 2, viewportHeight: 900, fovRadians: 0.87 };
    const proche = screenSpaceError({ ...base, distance: 100 });
    const loin = screenSpaceError({ ...base, distance: 1000 });
    expect(proche).toBeGreaterThan(loin);
    expect(proche / loin).toBeCloseTo(10, 1); // strictement inversement proportionnel

    const grand = screenSpaceError({ ...base, distance: 100, viewportHeight: 1800 });
    expect(grand).toBeCloseTo(proche * 2, 5);
  });

  it('force le raffinement quand la caméra est dans le nœud', () => {
    expect(
      screenSpaceError({ spacing: SPACING, level: 0, distance: 0, viewportHeight: 900, fovRadians: 0.87 }),
    ).toBe(Infinity);
  });
});

describe('selectNodes', () => {
  const opts = { center: CENTER, halfSize: HALF, spacing: SPACING, alwaysLevels: 0 };

  it('retient plus de nœuds de près que de loin', () => {
    // La mutation dans les deux sens : un seuil qui n'agirait pas, ou un
    // sélecteur qui renverrait tout, donnerait le même compte aux deux distances.
    const nodes = makeNodes();
    const proche = selectNodes(nodes, { ...VIEW, position: [0, 0, 600] }, opts);
    const loin = selectNodes(nodes, { ...VIEW, position: [0, 0, 40_000] }, opts);

    expect(proche.selected.length).toBeGreaterThan(loin.selected.length);
    expect(loin.rejected.tooCoarse).toBeGreaterThan(0);
    expect(proche.selected.length).toBe(nodes.length);
  });

  it('garde toujours les niveaux obligatoires, même très loin', () => {
    // Sans cela, s'éloigner assez vide entièrement l'écran : le rendu disparaît
    // au lieu de devenir grossier.
    const loin = selectNodes(makeNodes(), { ...VIEW, position: [0, 0, 500_000] }, { ...opts, alwaysLevels: 0 });
    expect(loin.selected).toHaveLength(1);
    expect(loin.selected[0].node.key.level).toBe(0);
    expect(loin.selected[0].mandatory).toBe(true);
  });

  it('respecte le plafond de points', () => {
    const nodes = makeNodes();
    const total = nodes.reduce((a, n) => a + n.pointCount, 0);
    const budget = Math.floor(total / 2);
    const r = selectNodes(nodes, VIEW, { ...opts, pointBudget: budget });

    expect(r.totalPoints).toBeLessThanOrEqual(budget);
    expect(r.rejected.budget).toBeGreaterThan(0);
    // Le plafond ne doit jamais vider l'écran : au moins un nœud passe même si
    // le budget est plus petit que le premier nœud.
    const minuscule = selectNodes(nodes, VIEW, { ...opts, pointBudget: 1 });
    expect(minuscule.selected.length).toBe(1);
  });

  it('sert le niveau 0 en premier pour couvrir l’écran tout de suite', () => {
    const r = selectNodes(makeNodes(), VIEW, { ...opts, alwaysLevels: 0 });
    expect(r.selected[0].node.key.level).toBe(0);
  });

  it('écarte ce qui est hors du champ, mais jamais l’obligatoire', () => {
    const vu = [];
    const isVisible = (bounds) => {
      vu.push(bounds);
      return bounds.min[0] >= 0; // ne garde que la moitié est
    };
    const r = selectNodes(makeNodes(), VIEW, { ...opts, alwaysLevels: 0, isVisible });

    expect(r.rejected.culled).toBeGreaterThan(0);
    expect(vu.length).toBeGreaterThan(0);
    // Le nœud racine est obligatoire : il n'est même pas soumis au test.
    expect(r.selected.some((c) => c.node.key.level === 0)).toBe(true);
    for (const c of r.selected) {
      if (!c.mandatory) expect(c.bounds.min[0]).toBeGreaterThanOrEqual(0);
    }
  });

  it('refuse des paramètres d’octree absurdes', () => {
    expect(() => selectNodes([], VIEW, { halfSize: 0, spacing: 1 })).toThrow(/halfSize/);
    expect(() => selectNodes([], VIEW, { halfSize: 1, spacing: 0 })).toThrow(/spacing/);
  });
});

describe('diffSelection', () => {
  it('n’ajoute que le manquant et ne retire que le superflu', () => {
    const selected = [
      { node: { id: 'a' } },
      { node: { id: 'b' } },
    ];
    const present = new Set(['b', 'c']);
    const { toAdd, toRemove } = diffSelection(selected, present);
    expect(toAdd.map((c) => c.node.id)).toEqual(['a']);
    expect(toRemove).toEqual(['c']);
  });

  it('ne bouge rien quand la sélection est déjà en place', () => {
    const selected = [{ node: { id: 'a' } }];
    const { toAdd, toRemove } = diffSelection(selected, new Set(['a']));
    expect(toAdd).toHaveLength(0);
    expect(toRemove).toHaveLength(0);
  });
});
