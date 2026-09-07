/**
 * Barre d'échelle et orientation pour une vue en perspective.
 *
 * Une échelle n'a de sens qu'à une profondeur donnée : en perspective, un mètre
 * au premier plan ne fait pas le même nombre de pixels qu'un mètre au fond. Elle
 * est donc calculée à la distance du point visé, et l'interface doit le dire —
 * sinon elle laisse croire à une mesure valable partout dans l'image.
 */

const NICE_LENGTHS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];

/** Pixels par mètre à la profondeur `distance`, pour une caméra en perspective. */
export function pixelsPerMetre({ viewportHeight, fovRadians, distance }) {
  if (!(distance > 0) || !(viewportHeight > 0)) return 0;
  return viewportHeight / (2 * Math.tan(fovRadians / 2) * distance);
}

/**
 * Choisit une longueur ronde dont la barre tombe dans la plage voulue.
 * On retient la plus grande qui tient : une barre trop courte se lit mal.
 */
export function chooseScale({ pixelsPerMetre: ppm, minPx = 60, maxPx = 150 }) {
  if (!(ppm > 0)) return null;
  let best = null;
  for (const metres of NICE_LENGTHS) {
    const px = metres * ppm;
    if (px >= minPx && px <= maxPx) best = { metres, px };
  }
  if (best) return best;
  // Aucune longueur ronde ne tombe dans la plage : on prend la moins mauvaise.
  const fallback = NICE_LENGTHS.map((m) => ({ metres: m, px: m * ppm })).sort(
    (a, b) => Math.abs(a.px - (minPx + maxPx) / 2) - Math.abs(b.px - (minPx + maxPx) / 2),
  )[0];
  return fallback ?? null;
}

/**
 * Attention : cette écriture suppose une valeur **déjà ronde**, celle que
 * `chooseScale` a choisie. Lui passer une longueur quelconque rend ses seize
 * décimales telles quelles. Pour une distance arbitraire, c'est
 * `formatDistance` d'`analysis/measure.js` qu'il faut appeler — les deux noms
 * se ressemblent, et l'un a déjà été renommé pour cette raison.
 */
export function formatLength(metres) {
  return metres >= 1000 ? `${metres / 1000} km` : `${metres} m`;
}

/**
 * Azimut de la direction de visée, en degrés depuis le nord et vers l'est.
 * En Lambert-93, +Y pointe vers le nord de la projection — ce n'est pas
 * exactement le nord géographique, l'écart atteignant quelques degrés sur les
 * bords du territoire.
 */
export function viewAzimuth(from, to) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  if (dx === 0 && dy === 0) return 0;
  const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
  return (deg + 360) % 360;
}

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];

export function cardinal(azimuth) {
  return CARDINALS[Math.round((azimuth % 360) / 45) % 8];
}
