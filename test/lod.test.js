import { describe, expect, it } from 'vitest';
import { distanceToBox, nodeBounds, nodeSpacing, screenSpaceError } from '../src/lod/octree.js';
import { diffSelection, selectAcross, selectNodes } from '../src/lod/selector.js';

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

describe('selectAcross — plusieurs dalles', () => {
  /** Deux dalles voisines de 1 km, la seconde décalée d'un kilomètre en X. */
  function deuxDalles() {
    return [
      { key: 'A', nodes: makeNodes(), center: [0, 0, 0], halfSize: HALF, spacing: SPACING },
      { key: 'B', nodes: makeNodes(), center: [1000, 0, 0], halfSize: HALF, spacing: SPACING },
    ];
  }

  it('donne des identifiants distincts aux nœuds homonymes', () => {
    // Le nœud racine de toute dalle s'appelle « 0-0-0-0 » : sans préfixe, la
    // seconde dalle serait prise pour la première et jamais affichée.
    const r = selectAcross(deuxDalles(), { ...VIEW, position: [500, 0, 900] }, { alwaysLevels: 0 });
    const racines = r.selected.filter((c) => c.node.key.level === 0);
    expect(racines).toHaveLength(2);
    expect(new Set(racines.map((c) => c.uid)).size).toBe(2);
    expect(racines.map((c) => c.uid).sort()).toEqual(['A|0-0-0-0', 'B|0-0-0-0']);
    expect(new Set(r.selected.map((c) => c.uid)).size).toBe(r.selected.length);
  });

  it('applique un plafond commun, pas un plafond par dalle', () => {
    // C'est le défaut qui ne se voit qu'à partir de la deuxième dalle : un
    // plafond appliqué dalle par dalle laisse passer N fois le budget.
    const groups = deuxDalles();
    const budget = 300_000;
    const r = selectAcross(groups, { ...VIEW, position: [500, 0, 700] }, { alwaysLevels: 0, pointBudget: budget });
    expect(r.totalPoints).toBeLessThanOrEqual(budget);
    expect(r.rejected.budget).toBeGreaterThan(0);

    const seule = selectAcross([groups[0]], { ...VIEW, position: [500, 0, 700] }, {
      alwaysLevels: 0,
      pointBudget: budget,
    });
    expect(seule.totalPoints).toBeLessThanOrEqual(budget);
  });

  it('sert les racines de toutes les dalles avant le détail de l’une d’elles', () => {
    const r = selectAcross(deuxDalles(), { ...VIEW, position: [0, 0, 700] }, { alwaysLevels: 0 });
    const deuxPremiers = r.selected.slice(0, 2).map((c) => c.node.key.level);
    expect(deuxPremiers).toEqual([0, 0]);
  });

  it('privilégie la dalle regardée quand le budget est serré', () => {
    // Caméra franchement au-dessus de B : à budget contraint, le détail doit
    // aller à B, pas se répartir également.
    const r = selectAcross(deuxDalles(), { ...VIEW, position: [1000, 0, 300] }, {
      alwaysLevels: 0,
      pointBudget: 800_000,
    });
    const parDalle = { A: 0, B: 0 };
    for (const c of r.selected) parDalle[c.groupKey] += c.node.pointCount;
    expect(parDalle.B).toBeGreaterThan(parDalle.A);
  });

  it('cumule les rejets de toutes les dalles', () => {
    const r = selectAcross(deuxDalles(), { ...VIEW, position: [0, 0, 200_000] }, { alwaysLevels: 0 });
    expect(r.groups).toBe(2);
    expect(r.rejected.tooCoarse).toBeGreaterThan(0);
    expect(r.selected).toHaveLength(2); // une racine par dalle, rien d'autre
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

  it('distingue deux nœuds homonymes venus de dalles différentes', () => {
    // Sans identifiant global, les deux racines « 0-0-0-0 » se confondent : la
    // seconde dalle est réputée déjà en scène et ne se charge jamais. Les cas
    // ci-dessus ne portent pas d'`uid`, donc ils ne l'éprouvent pas.
    const selected = [
      { uid: 'A|0-0-0-0', node: { id: '0-0-0-0' } },
      { uid: 'B|0-0-0-0', node: { id: '0-0-0-0' } },
    ];
    const { toAdd, toRemove } = diffSelection(selected, new Set(['A|0-0-0-0']));
    expect(toAdd.map((c) => c.uid)).toEqual(['B|0-0-0-0']);
    expect(toRemove).toEqual([]);
  });

  it('retire un nœud d’une dalle relâchée sans toucher à son homonyme', () => {
    const selected = [{ uid: 'B|0-0-0-0', node: { id: '0-0-0-0' } }];
    const { toAdd, toRemove } = diffSelection(selected, new Set(['A|0-0-0-0', 'B|0-0-0-0']));
    expect(toRemove).toEqual(['A|0-0-0-0']);
    expect(toAdd).toHaveLength(0);
  });
});
