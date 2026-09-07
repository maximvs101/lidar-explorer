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
 * Sélection sur plusieurs dalles à la fois.
 *
 * Chaque dalle a son propre octree — centre, demi-côté et espacement lui sont
 * propres — mais le plafond de points est **commun** : il porte sur ce que la
 * carte graphique doit tenir, pas sur une dalle en particulier. On sélectionne
 * donc dalle par dalle sans plafond, puis on tranche une seule fois sur
 * l'ensemble trié. Appliquer le plafond par dalle donnerait N fois le budget
 * dès qu'on en affiche plusieurs.
 *
 * Chaque groupe porte un `key` qui rend les identifiants uniques : le nœud
 * racine de toute dalle s'appelle « 0-0-0-0 », et sans préfixe la deuxième
 * dalle chargée serait prise pour la première, déjà en scène.
 *
 * Note pour qui relirait ce code : passer `pointBudget` au lieu d'`Infinity`
 * dans l'appel par groupe ne change rien d'observable tant que le plafond est le
 * même partout — le tri final, de même ordre, retranche derrière. Le test de
 * mutation ne peut donc pas l'attraper. `Infinity` reste la bonne écriture parce
 * qu'elle dit ce qu'on veut : un seul arbitrage, sur l'ensemble.
 */
export function selectAcross(groups, view, options = {}) {
  const { pointBudget = 4_000_000, ...perGroup } = options;
  const candidates = [];
  const rejected = { culled: 0, tooCoarse: 0, budget: 0 };

  for (const group of groups) {
    const result = selectNodes(group.nodes, view, {
      ...perGroup,
      center: group.center,
      halfSize: group.halfSize,
      spacing: group.spacing,
      pointBudget: Infinity,
    });
    rejected.culled += result.rejected.culled;
    rejected.tooCoarse += result.rejected.tooCoarse;
    for (const candidate of result.selected) {
      candidates.push({ ...candidate, groupKey: group.key, uid: `${group.key}|${candidate.node.id}` });
    }
  }

  candidates.sort((a, b) => {
    if (a.mandatory !== b.mandatory) return a.mandatory ? -1 : 1;
    return b.error - a.error;
  });

  const selected = [];
  let totalPoints = 0;
  for (const candidate of candidates) {
    if (totalPoints + candidate.node.pointCount > pointBudget && selected.length > 0) {
      rejected.budget += 1;
      continue;
    }
    selected.push(candidate);
    totalPoints += candidate.node.pointCount;
  }

  return { selected, totalPoints, rejected, groups: groups.length };
}

/**
 * Compare la sélection voulue à ce qui est déjà en scène.
 * `toAdd` est ordonné par priorité : le premier chargé est le plus utile.
 * L'identité d'un élément est son `uid` s'il en a un — indispensable dès
 * qu'il y a plus d'une dalle — et son identifiant de nœud sinon.
 */
export function diffSelection(selected, present) {
  const idOf = (c) => c.uid ?? c.node.id;
  const wanted = new Set(selected.map(idOf));
  const toAdd = selected.filter((c) => !present.has(idOf(c)));
  const toRemove = [...present].filter((id) => !wanted.has(id));
  return { toAdd, toRemove };
}
