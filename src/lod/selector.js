import { distanceToBox, nodeBounds, screenSpaceError } from './octree.js';

/**
 * Choisit les nœuds à afficher pour une position de caméra donnée.
 *
 * Fonction pure : elle ne connaît ni Three.js ni le réseau. La visibilité est
 * fournie par `isVisible`, ce qui permet de l'éprouver sans navigateur tout en
 * branchant un vrai test de frustum dans l'application.
 *
 * Deux garanties tiennent l'affichage :
 *  - les niveaux `alwaysLevels` sont retenus quoi qu'il arrive, pour qu'il y ait
 *    toujours quelque chose à l'écran plutôt qu'un trou pendant le raffinement ;
 *  - le total de points est plafonné, donc la mémoire ne dépend pas de la durée
 *    de navigation. Sans ce plafond, se promener assez longtemps finit toujours
 *    par tout charger.
 */
export function selectNodes(nodes, view, options = {}) {
  const {
    center = [0, 0, 0],
    halfSize,
    spacing,
    minScreenError = 1.5,
    pointBudget = 4_000_000,
    alwaysLevels = 0,
    isVisible = () => true,
  } = options;

  if (!(halfSize > 0)) throw new Error('halfSize doit être positif');
  if (!(spacing > 0)) throw new Error('spacing doit être positif');

  const candidates = [];
  let culled = 0;
  let tooCoarse = 0;

  for (const node of nodes) {
    const bounds = nodeBounds(node.key, center, halfSize);
    const mandatory = node.key.level <= alwaysLevels;

    if (!mandatory && !isVisible(bounds)) {
      culled += 1;
      continue;
    }

    const distance = distanceToBox(bounds, view.position);
    const error = screenSpaceError({
      spacing,
      level: node.key.level,
      distance,
      viewportHeight: view.viewportHeight,
      fovRadians: view.fovRadians,
    });

    if (!mandatory && error < minScreenError) {
      tooCoarse += 1;
      continue;
    }
    candidates.push({ node, bounds, distance, error, mandatory });
  }

  // Priorité : d'abord ce qui doit toujours être là, puis la plus grande erreur
  // écran — c'est-à-dire ce qui manque le plus au rendu, pas ce qui est le plus
  // proche : un nœud grossier tout près apporte moins qu'un nœud fin bien placé.
  candidates.sort((a, b) => {
    if (a.mandatory !== b.mandatory) return a.mandatory ? -1 : 1;
    if (a.node.key.level !== b.node.key.level && (a.mandatory || b.mandatory)) {
      return a.node.key.level - b.node.key.level;
    }
    return b.error - a.error;
  });

  const selected = [];
  let totalPoints = 0;
  let droppedForBudget = 0;

  for (const candidate of candidates) {
    if (totalPoints + candidate.node.pointCount > pointBudget && selected.length > 0) {
      droppedForBudget += 1;
      continue;
    }
    selected.push(candidate);
    totalPoints += candidate.node.pointCount;
  }

  return {
    selected,
    totalPoints,
    rejected: { culled, tooCoarse, budget: droppedForBudget },
  };
}

/**
 * Compare la sélection voulue à ce qui est déjà en scène.
 * `toAdd` est ordonné par priorité : le premier chargé est le plus utile.
 */
export function diffSelection(selected, present) {
  const wanted = new Set(selected.map((c) => c.node.id));
  const toAdd = selected.filter((c) => !present.has(c.node.id));
  const toRemove = [...present].filter((id) => !wanted.has(id));
  return { toAdd, toRemove };
}
