import { DEFAULT_PALETTE, NEUTRAL_PALETTE } from './pointsMaterial.js';
import { RELIEF_DEFAULTS } from './relief.js';

/**
 * Presets d'affichage : une configuration nommée regroupant nuancier, fond,
 * source de couleur et réglages de relief.
 *
 * Ils ne fixent ni la taille ni la forme des points, ni le seuil de détail : ce
 * sont des préférences d'affichage, conservées d'un preset à l'autre pour qu'on
 * puisse comparer deux rendus sans avoir à les régler de nouveau. Un preset peut
 * cependant les imposer en déclarant `boost` ou `round`.
 *
 * Les points sont ronds partout, et aucun preset ne les grossit. Le carré et le
 * grossissement avaient été retenus du temps où les points laissaient voir le
 * fond entre eux ; mesure faite, ni l'un ni l'autre ne comblait plus rien — au
 * mieux 0,18 point de pourcentage de trous en moins — et il ne restait que leur
 * inconvénient : un point plus large que son espacement recouvre son voisin, et
 * c'est la résolution qu'on est allé chercher dans la donnée qui s'efface.
 */

/** Réglages de relief communs, que chaque preset ajuste par recouvrement. */
const BASE = { ...RELIEF_DEFAULTS };

export const PRESETS = {
  lecture: {
    label: 'lecture',
    palette: DEFAULT_PALETTE,
    background: 0x080a0e,
    post: false,
    colorMode: 'classe',
  },
  relief: {
    label: 'relief',
    palette: NEUTRAL_PALETTE,
    background: 0xeef0f2,
    post: true,
    colorMode: 'classe',
    // Le relief seul, appuyé : c'est la vue qui donne le plus à lire sur la
    // structure du bâti, sans qu'aucune rampe ne concurrence l'ombrage.
    relief: { ...BASE, strength: 20, lightAmount: 0.7 },
  },
  canopee: {
    label: 'canopée',
    palette: NEUTRAL_PALETTE,
    background: 0xf4f1e8,
    post: true,
    colorMode: 'hauteur',
    heightMax: 30,
    // Ombrage discret : la rampe de hauteur porte déjà l'information, la
    // renforcer fausserait la lecture des couleurs.
    relief: { ...BASE, strength: 12, lightAmount: 0.35 },
  },
};

export const PRESET_NAMES = Object.keys(PRESETS);

export function getPreset(name) {
  return PRESETS[name] ?? PRESETS.lecture;
}
