import { DEFAULT_PALETTE, MODEL_PALETTE } from './pointsMaterial.js';

/**
 * Presets d'affichage : une configuration nommée regroupant forme de découpe,
 * nuancier, fond, socle et réglages de post-traitement.
 *
 * L'idée vient de prettymaps (Marcelo Prates, AGPL-3.0), dont aucun code n'est
 * repris ici — sa clause réseau se déclencherait sur un usage web, et il n'y a
 * de toute façon rien de transposable entre du matplotlib 2D vectoriel sur
 * OpenStreetMap et du WebGL sur nuage de points. Ce qui est repris est
 * l'organisation : des styles nommés que l'on bascule d'un clic, plutôt qu'une
 * douzaine de réglages épars.
 */

/**
 * Nuancier « plan » : plus affirmé que le nuancier maquette, dans la veine des
 * cartes dessinées — ocre chaud pour le bâti, crème pour le sol, bleu franc pour
 * l'eau. La variation de teinte y est poussée : c'est elle qui tient lieu de
 * palette par bâtiment, faute d'une segmentation qui nous dirait où commence et
 * où finit chaque édifice.
 */
export const PLAN_PALETTE = {
  1: [188, 178, 162],
  2: [238, 228, 206],
  3: [176, 190, 128],
  4: [148, 172, 104],
  5: [122, 152, 86],
  6: [226, 164, 106],
  9: [122, 168, 200],
  17: [206, 198, 184],
  64: [222, 196, 140],
  65: [190, 158, 184],
  66: [122, 168, 200],
  67: [198, 190, 178],
};

/** Réglages de rendu communs, que chaque preset ajuste par recouvrement. */
const BASE = {
  strength: 16,
  radius: 2.4,
  saturation: 1.18,
  vignette: 0.24,
  tiltFocus: 0.54,
  tiltBand: 0.22,
  tiltAmount: 0.85,
  lightAzimuth: 315,
  lightAltitude: 48,
  lightAmount: 0.55,
  lightSpread: 6,
  tint: 0.16,
};

export const PRESETS = {
  lecture: {
    label: 'lecture',
    palette: DEFAULT_PALETTE,
    background: 0x080a0e,
    post: false,
    shape: null,
    round: true,
    boost: 1,
    tint: 0,
  },
  maquette: {
    label: 'maquette',
    palette: MODEL_PALETTE,
    background: 0xece7dd,
    plinth: 0xcabfa8,
    post: true,
    shape: 'circle',
    radius: 450,
    round: false,
    boost: 1.55,
    diorama: { ...BASE },
  },
  plan: {
    label: 'plan carré',
    palette: PLAN_PALETTE,
    background: 0xf2ece0,
    plinth: 0xd8c9ac,
    post: true,
    shape: 'square',
    radius: 420,
    round: false,
    boost: 1.6,
    // Ombrage plus marqué et vignettage plus discret : on cherche le trait net
    // d'une carte dessinée, pas la douceur d'une maquette de résine. La teinte
    // varie davantage pour que les îlots voisins se distinguent.
    diorama: { ...BASE, strength: 22, vignette: 0.16, saturation: 1.24, tint: 0.24, lightAmount: 0.62 },
  },
};

export const PRESET_NAMES = Object.keys(PRESETS);

export function getPreset(name) {
  return PRESETS[name] ?? PRESETS.lecture;
}
