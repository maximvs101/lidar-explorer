/**
 * Statistiques de classification.
 *
 * Toute comparaison de répartition doit se faire à **emprise identique**.
 * Comparer les classes d'une vue d'ensemble à celles d'un quartier ne dit rien
 * sur l'échantillonnage : cela ne compare que deux endroits différents. La seule
 * façon honnête de tester le niveau de détail est de prendre un nœud et ses
 * propres descendants, dont l'emprise coïncide par construction.
 */

export const CLASS_NAMES = {
  1: 'non classé',
  2: 'sol',
  3: 'végétation basse',
  4: 'végétation moyenne',
  5: 'végétation haute',
  6: 'bâtiment',
  9: 'eau',
  17: 'pont',
  64: 'sursol pérenne',
  65: 'artefact',
  66: 'point virtuel',
  67: 'divers',
};

export function className(code) {
  return CLASS_NAMES[code] ?? `classe ${code}`;
}

/** Compte des points par code de classe. */
export function histogram(classification, into = new Map()) {
  for (let i = 0; i < classification.length; i += 1) {
    const c = classification[i];
    into.set(c, (into.get(c) ?? 0) + 1);
  }
  return into;
}

export function totalOf(hist) {
  let total = 0;
  for (const n of hist.values()) total += n;
  return total;
}

/** Parts en pourcentage, triées par importance décroissante. */
export function shares(hist) {
  const total = totalOf(hist);
  if (total === 0) return [];
  return [...hist.entries()]
    .map(([code, count]) => ({ code, count, share: (100 * count) / total }))
    .sort((a, b) => b.share - a.share);
}

/**
 * Un nœud est-il un descendant d'un autre dans l'octree ?
 * À chaque niveau de descente, les indices doublent : le nœud (3, 5, 2, 1) a
 * pour ancêtre de niveau 2 le nœud (2, 2, 1, 0).
 */
export function isDescendant(ancestor, node) {
  if (node.level < ancestor.level) return false;
  const shift = node.level - ancestor.level;
  return (
    node.x >> shift === ancestor.x &&
    node.y >> shift === ancestor.y &&
    node.z >> shift === ancestor.z
  );
}

/** Le nœud lui-même et tous ses descendants, groupés par niveau. */
export function subtreeByLevel(nodes, rootKey) {
  const byLevel = new Map();
  for (const node of nodes) {
    if (!isDescendant(rootKey, node.key)) continue;
    if (!byLevel.has(node.key.level)) byLevel.set(node.key.level, []);
    byLevel.get(node.key.level).push(node);
  }
  return [...byLevel.entries()].sort((a, b) => a[0] - b[0]).map(([level, list]) => ({ level, nodes: list }));
}

/**
 * Écart maximal, en points de pourcentage, entre deux répartitions.
 * C'est ce chiffre qui tranche : en deçà de quelques points, les deux
 * échantillons décrivent la même chose ; au-delà, l'un des deux ment.
 */
export function maxDivergence(sharesA, sharesB) {
  const a = new Map(sharesA.map((s) => [s.code, s.share]));
  const b = new Map(sharesB.map((s) => [s.code, s.share]));
  let worst = { code: null, a: 0, b: 0, delta: 0 };
  for (const code of new Set([...a.keys(), ...b.keys()])) {
    const va = a.get(code) ?? 0;
    const vb = b.get(code) ?? 0;
    const delta = Math.abs(va - vb);
    if (delta > worst.delta) worst = { code, a: va, b: vb, delta };
  }
  return worst;
}
