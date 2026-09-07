/**
 * Géométrie de l'octree COPC.
 *
 * L'octree est cubique et englobe la dalle : son demi-côté vaut 500 m pour une
 * dalle kilométrique, mais son centre en Z est celui du cube, pas celui des
 * points — sur une dalle dont les altitudes vont de 132 à 193 m, le centre de
 * l'octree est à 632 m. Se servir de ce centre comme repère d'altitude serait
 * une erreur ; il ne sert qu'à situer les nœuds les uns par rapport aux autres.
 */

/** Emprise d'un nœud, d'après sa clé (level, x, y, z). */
export function nodeBounds(key, center, halfSize) {
  const size = (halfSize * 2) / 2 ** key.level;
  const minX = center[0] - halfSize + key.x * size;
  const minY = center[1] - halfSize + key.y * size;
  const minZ = center[2] - halfSize + key.z * size;
  return {
    min: [minX, minY, minZ],
    max: [minX + size, minY + size, minZ + size],
    size,
  };
}

/** Espacement moyen entre points à ce niveau : il est divisé par deux à chaque descente. */
export function nodeSpacing(rootSpacing, level) {
  return rootSpacing / 2 ** level;
}

/** Distance d'un point au plus proche point d'une boîte (0 si le point est dedans). */
export function distanceToBox(bounds, point) {
  let sum = 0;
  for (let i = 0; i < 3; i += 1) {
    const v = point[i];
    const d = v < bounds.min[i] ? bounds.min[i] - v : v > bounds.max[i] ? v - bounds.max[i] : 0;
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * Erreur en espace écran : de combien de pixels seraient séparés deux points
 * voisins de ce nœud, vus d'ici. C'est le critère qui décide s'il vaut la peine
 * de raffiner — en deçà d'un pixel ou deux, les points supplémentaires tombent
 * les uns sur les autres et ne coûtent que de la mémoire.
 */
export function screenSpaceError({ spacing, level, distance, viewportHeight, fovRadians }) {
  const at = nodeSpacing(spacing, level);
  // Un nœud dans lequel la caméra se trouve doit être raffiné au maximum, pas
  // divisé par une distance nulle.
  if (!(distance > 0)) return Infinity;
  const projection = viewportHeight / (2 * Math.tan(fovRadians / 2));
  return (at / distance) * projection;
}
