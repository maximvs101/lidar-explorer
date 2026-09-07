/**
 * Tracé du profil en travers.
 *
 * Un nuage de points vu de côté, aplati sur le plan vertical du segment :
 * en abscisse la distance parcourue, en ordonnée l'altitude NGF. C'est là que
 * se lisent d'un coup la hauteur d'un bâtiment, le profil d'un talus ou
 * l'épaisseur d'une haie.
 *
 * Le module ne calcule rien : il reçoit un échantillon déjà projeté par
 * `analysis/section.js` et le dessine. Les deux se partagent la géométrie pour
 * que le tracé décrive exactement la bande masquée dans la scène.
 */

import { verticalBounds, verticalExaggeration } from '../analysis/section.js';

const MARGE = { gauche: 46, droite: 8, haut: 16, bas: 20 };

const COULEURS = {
  fond: '#0e1116',
  cadre: '#263041',
  grille: 'rgba(127, 209, 255, 0.10)',
  texte: '#8b949e',
  terrain: '#ffd479',
};

/** Pas de graduation « rond » le plus proche, pour ne pas écrire 37,4 m. */
function pasRond(etendue, cibles = 5) {
  const brut = etendue / Math.max(cibles, 1);
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(brut, 1e-9)));
  for (const facteur of [1, 2, 5, 10]) {
    if (magnitude * facteur >= brut) return magnitude * facteur;
  }
  return magnitude * 10;
}

/**
 * Dessine le profil.
 *
 * `terrainAt(along)` est facultatif : il rend l'altitude du sol à cette
 * distance, ou NaN. Sans lui, le tracé se contente des points — mais avec, on
 * lit directement une hauteur au-dessus du sol, ce qui est la question qu'on se
 * pose neuf fois sur dix.
 */
export function drawProfile(canvas, { sample, length, palette, terrainAt } = {}) {
  const ctx = canvas.getContext('2d');
  const ratio = Math.min(globalThis.devicePixelRatio ?? 1, 2);
  const w = Math.max(2, Math.round(canvas.clientWidth || canvas.width));
  const h = Math.max(2, Math.round(canvas.clientHeight || canvas.height));
  if (canvas.width !== w * ratio || canvas.height !== h * ratio) {
    canvas.width = w * ratio;
    canvas.height = h * ratio;
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = COULEURS.fond;
  ctx.fillRect(0, 0, w, h);

  const aire = {
    x: MARGE.gauche,
    y: MARGE.haut,
    w: Math.max(2, w - MARGE.gauche - MARGE.droite),
    h: Math.max(2, h - MARGE.haut - MARGE.bas),
  };
  const bornes = verticalBounds(sample);
  const enX = (along) => aire.x + (length > 0 ? (along / length) * aire.w : 0);
  const enY = (z) => aire.y + aire.h - ((z - bornes.min) / bornes.span) * aire.h;

  ctx.font = '10px ui-monospace, Consolas, monospace';
  ctx.fillStyle = COULEURS.texte;
  ctx.strokeStyle = COULEURS.grille;
  ctx.lineWidth = 1;

  // --- Graduations verticales, en altitude NGF.
  const pasZ = pasRond(bornes.span, 4);
  for (let z = Math.ceil(bornes.min / pasZ) * pasZ; z <= bornes.max; z += pasZ) {
    const y = Math.round(enY(z)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(aire.x, y);
    ctx.lineTo(aire.x + aire.w, y);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${Math.round(z)}`, aire.x - 5, y);
  }

  // --- Graduations horizontales, en distance parcourue.
  const pasX = pasRond(length, 5);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let d = 0; d <= length + 1e-6; d += pasX) {
    const x = Math.round(enX(d)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, aire.y);
    ctx.lineTo(x, aire.y + aire.h);
    ctx.stroke();
    ctx.fillText(`${Math.round(d)}`, x, aire.y + aire.h + 4);
  }

  // --- Les points, un rectangle d'un pixel chacun.
  const defaut = [140, 140, 148];
  for (let i = 0; i < sample.count; i += 1) {
    const c = palette?.[sample.classification[i]] ?? defaut;
    ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    ctx.fillRect(enX(sample.along[i]) - 0.5, enY(sample.z[i]) - 0.5, 1.6, 1.6);
  }

  // --- Le sol officiel, par-dessus : c'est la référence, elle doit rester lisible.
  if (terrainAt) {
    ctx.strokeStyle = COULEURS.terrain;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    let trace = false;
    for (let px = 0; px <= aire.w; px += 1) {
      const along = length * (px / aire.w);
      const z = terrainAt(along);
      if (!Number.isFinite(z)) { trace = false; continue; }
      const x = aire.x + px;
      const y = enY(z);
      if (trace) ctx.lineTo(x, y);
      else { ctx.moveTo(x, y); trace = true; }
    }
    ctx.stroke();
  }

  ctx.strokeStyle = COULEURS.cadre;
  ctx.lineWidth = 1;
  ctx.strokeRect(aire.x + 0.5, aire.y + 0.5, aire.w - 1, aire.h - 1);

  // --- L'exagération verticale, annoncée. Tous les profils étirent la
  // verticale ; presque aucun ne le dit, et on finit par lire des pentes qui
  // n'existent pas.
  const facteur = verticalExaggeration({
    length, zSpan: bornes.span, width: aire.w, height: aire.h,
  });
  ctx.fillStyle = COULEURS.texte;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('m NGF', 2, 2);
  ctx.textAlign = 'right';
  const note = Number.isFinite(facteur) ? `hauteurs ×${facteur.toFixed(1)}` : '';
  ctx.fillText(sample.truncated ? `${note} · tronqué` : note, w - 2, 2);

  return { bounds: bornes, exaggeration: facteur };
}
