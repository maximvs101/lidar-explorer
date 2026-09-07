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
 *
 * Les points sont ronds partout, et aucun preset ne les grossit. Le carré avait
 * été retenu du temps où ils étaient élargis et laissaient voir le fond entre
 * eux ; une fois l'élargissement retiré, l'écart de trous ne dépassait plus
 * 0,18 point de pourcentage. `round: false` reste disponible pour un preset qui
 * voudrait l'aspect mosaïque, et l'interface laisse le choix à la volée.
 *
 * Aucun preset ne fixe la taille ni la forme des points : ce sont des
 * preferences d'affichage, conservees d'un preset a l'autre pour qu'on puisse
 * comparer deux rendus sans avoir a les regler de nouveau. Un preset peut
 * cependant les imposer en declarant `boost` ou `round`.
 *
 * Aucun preset ne grossit les points. Ils l'ont fait un temps, pour éviter que
 * le fond transparaisse entre eux ; mesure faite, ce grossissement ne corrige
 * plus rien depuis que l'ombrage a été adouci — moins d'un point de pourcentage
 * de trous en moins, à toutes les distances. Il ne restait que son inconvénient :
 * un point plus large que son espacement recouvre son voisin, et c'est
 * exactement la résolution qu'on est allé chercher dans la donnée qui s'efface.
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

/**
 * Nuanciers repris de prettymapp (Christoph Rieke), sous licence MIT :
 *
 *   Copyright (c) 2023 Christoph Rieke — https://github.com/chrieke/prettymapp
 *
 * Contrairement à prettymaps (AGPL-3.0), cette licence permet la reprise ; ce
 * sont ses valeurs de couleur qui sont reprises, transposées de ses catégories
 * OpenStreetMap vers les classes ASPRS du LiDAR :
 *
 *   urban -> bâtiment (6)        water -> eau (9, 66)
 *   woodland -> végétation haute (5)   grassland -> végétation basse (3, 4)
 *   streets -> pont (17)         other -> sol (2)
 *
 * Une entrée peut être une liste de couleurs : les points s'y répartissent
 * selon leur position, ce qui rend l'équivalent du `cmap` d'origine, où chaque
 * bâtiment tire sa teinte dans une gamme.
 */
const NEUTRES = { 1: [176, 170, 160], 64: [206, 180, 130], 65: [178, 150, 176], 67: [186, 182, 176] };

export const PEACH_PALETTE = {
  ...NEUTRES,
  2: [242, 244, 203],
  3: [208, 241, 191],
  4: [176, 218, 160],
  5: [100, 185, 106],
  6: [[255, 200, 87], [233, 114, 76], [197, 40, 61]],
  9: [161, 227, 255],
  17: [47, 55, 55],
  66: [161, 227, 255],
};

export const AUBURN_PALETTE = {
  ...NEUTRES,
  2: [242, 244, 203],
  3: [139, 177, 116],
  4: [120, 165, 100],
  5: [100, 185, 106],
  6: [[67, 54, 51], [255, 94, 91], [255, 94, 91]],
  9: [168, 225, 230],
  17: [47, 55, 55],
  66: [168, 225, 230],
};

export const CITRUS_PALETTE = {
  ...NEUTRES,
  2: [234, 226, 183],
  3: [85, 166, 48],
  4: [110, 176, 32],
  5: [128, 185, 24],
  6: [[255, 255, 63], [244, 213, 141], [245, 203, 92]],
  9: [0, 127, 95],
  17: [255, 255, 255],
  66: [0, 127, 95],
};

export const PRESETS = {
  lecture: {
    label: 'lecture',
    palette: DEFAULT_PALETTE,
    background: 0x080a0e,
    post: false,
    shape: null,
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
    // Ombrage plus marqué et vignettage plus discret : on cherche le trait net
    // d'une carte dessinée, pas la douceur d'une maquette de résine. La teinte
    // varie davantage pour que les îlots voisins se distinguent.
    diorama: { ...BASE, strength: 22, vignette: 0.16, saturation: 1.24, tint: 0.24, lightAmount: 0.62 },
  },
  canopee: {
    label: 'canopée',
    palette: MODEL_PALETTE,
    background: 0xf4f1e8,
    post: true,
    shape: null,
    // La couleur vient de la hauteur au-dessus du sol, pas de la classe.
    heightMode: true,
    heightMax: 30,
    // Ombrage discret et aucune saturation ajoutée : la rampe de hauteur porte
    // déjà l'information, la renforcer fausserait la lecture des couleurs.
    diorama: { ...BASE, strength: 12, saturation: 1, tint: 0, vignette: 0.14, lightAmount: 0.35 },
  },
  audit: {
    label: 'audit',
    palette: MODEL_PALETTE,
    background: 0xf6f5f2,
    post: false,
    shape: null,
    // Rouge : végétation haute posée au sol. Magenta : bâtiment enterré.
    // Gris neutre : rien à redire — ce qui n'est pas la même chose que vérifié.
    auditMode: true,
  },
  peach: {
    label: 'peach',
    palette: PEACH_PALETTE,
    background: 0xf2f4cb,
    plinth: 0xdcdeb4,
    post: true,
    shape: 'square',
    radius: 420,
    // Nuanciers vifs pensés pour du dessin à plat : on baisse la saturation
    // ajoutée et la variation de teinte, que la gamme de couleurs fournit déjà.
    diorama: { ...BASE, strength: 20, saturation: 1.04, tint: 0.06, vignette: 0.18 },
  },
  auburn: {
    label: 'auburn',
    palette: AUBURN_PALETTE,
    background: 0xf2f4cb,
    plinth: 0xd6d8a8,
    post: true,
    shape: 'circle',
    radius: 450,
    diorama: { ...BASE, strength: 20, saturation: 1.04, tint: 0.06, vignette: 0.18 },
  },
  citrus: {
    label: 'citrus',
    palette: CITRUS_PALETTE,
    background: 0xeae2b7,
    plinth: 0xd2c89c,
    post: true,
    shape: 'square',
    radius: 420,
    diorama: { ...BASE, strength: 20, saturation: 1.04, tint: 0.06, vignette: 0.18 },
  },
};

export const PRESET_NAMES = Object.keys(PRESETS);

export function getPreset(name) {
  return PRESETS[name] ?? PRESETS.lecture;
}
