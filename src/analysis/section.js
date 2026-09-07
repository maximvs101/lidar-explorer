/**
 * Coupe : ce qui se trouve dans une bande le long d'un segment.
 *
 * C'est l'outil qui fait passer de « je regarde » à « je mesure » : une
 * tranche verticale du nuage, où l'on lit d'un coup la hauteur du bâti, le
 * profil d'un talus ou l'épaisseur d'une haie.
 *
 * Le module ne connaît ni Three.js ni le canevas. Il projette des points sur un
 * segment et rend des couples (distance le long, altitude) ; le dessin et le
 * masquage dans la scène sont ailleurs, et lisent la même géométrie.
 */

/**
 * Projection d'un point sur le segment, en plan.
 *
 * `t` est l'abscisse curviligne, bornée au segment : au-delà des extrémités, la
 * bande a des bouts arrondis plutôt que de s'étendre le long de la droite
 * porteuse — un point à 2 km derrière A n'appartient pas à la coupe.
 *
 * Le shader fait exactement le même calcul pour masquer la scène. Les deux
 * doivent rester d'accord, sans quoi le profil décrirait autre chose que ce
 * qu'on voit.
 */
export function sectionAxis(a, b) {
  const bx = b[0] - a[0];
  const by = b[1] - a[1];
  const length = Math.hypot(bx, by);
  const carre = Math.max(bx * bx + by * by, 1e-12);
  return {
    length,
    /** Rend la distance le long du segment et l'écart perpendiculaire. */
    project(x, y) {
      const px = x - a[0];
      const py = y - a[1];
      const t = Math.min(1, Math.max(0, (px * bx + py * by) / carre));
      const dx = px - bx * t;
      const dy = py - by * t;
      return { along: t * length, offset: Math.hypot(dx, dy) };
    },
  };
}

/** Un échantillon vide, prêt à être rempli lot par lot. */
export function emptySection(capacity = 240_000) {
  return {
    along: new Float32Array(capacity),
    z: new Float32Array(capacity),
    classification: new Uint8Array(capacity),
    count: 0,
    tested: 0,
    truncated: false,
    zMin: Infinity,
    zMax: -Infinity,
  };
}

/**
 * Accumule les points d'un lot qui tombent dans la bande.
 *
 * La capacité est bornée : un profil n'a pas besoin de plus de points que le
 * canevas n'a de pixels, et une coupe traversant toute une dalle en offrirait
 * des millions. Quand le plafond est atteint, `truncated` le dit — un profil
 * tronqué en silence donnerait une enveloppe fausse, et c'est précisément
 * l'enveloppe qu'on vient y lire.
 */
export function addToSection(sample, axis, width, positions, classification) {
  const demi = width / 2;
  for (let n = 0; n < classification.length; n += 1) {
    sample.tested += 1;
    const { along, offset } = axis.project(positions[n * 3], positions[n * 3 + 1]);
    if (offset > demi) continue;
    if (sample.count >= sample.along.length) {
      sample.truncated = true;
      return sample;
    }
    const z = positions[n * 3 + 2];
    sample.along[sample.count] = along;
    sample.z[sample.count] = z;
    sample.classification[sample.count] = classification[n];
    sample.count += 1;
    if (z < sample.zMin) sample.zMin = z;
    if (z > sample.zMax) sample.zMax = z;
  }
  return sample;
}

/**
 * Facteur d'exagération verticale d'un tracé.
 *
 * Un profil de 300 m de long pour 40 m de dénivelé, dessiné dans un rectangle,
 * étire toujours la verticale. Tous les profils du monde le font ; presque
 * aucun ne le dit, et on finit par lire des pentes qui n'existent pas.
 */
export function verticalExaggeration({ length, zSpan, width, height }) {
  if (!(length > 0) || !(zSpan > 0) || !(width > 0) || !(height > 0)) return NaN;
  return (height / zSpan) / (width / length);
}

/**
 * Bornes verticales du tracé, avec une marge et un minimum d'amplitude.
 *
 * Sans plancher, une coupe sur une surface plane donnerait une amplitude nulle
 * puis une division par zéro, et le tracé s'effondrerait sur une ligne.
 */
export function verticalBounds(sample, { margin = 0.05, minSpan = 2 } = {}) {
  if (sample.count === 0) return { min: 0, max: minSpan, span: minSpan };
  let min = sample.zMin;
  let max = sample.zMax;
  const brut = max - min;
  if (brut < minSpan) {
    const milieu = (min + max) / 2;
    min = milieu - minSpan / 2;
    max = milieu + minSpan / 2;
  } else {
    min -= brut * margin;
    max += brut * margin;
  }
  return { min, max, span: max - min };
}
