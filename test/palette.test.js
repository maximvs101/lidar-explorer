import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE, MODEL_PALETTE } from '../src/render/pointsMaterial.js';
import { DIORAMA_DEFAULTS, lightVector } from '../src/render/diorama.js';
import { PRESETS, PRESET_NAMES, getPreset } from '../src/render/presets.js';
import { CLASS_NAMES } from '../src/analysis/classStats.js';

describe('palettes', () => {
  it('couvrent exactement les mêmes classes', () => {
    // Un code présent d'un côté seulement passerait au gris de repli en changeant
    // de mode, sans erreur ni message : la classe existe encore dans la légende
    // mais devient invisible à l'œil.
    expect(Object.keys(MODEL_PALETTE).sort()).toEqual(Object.keys(DEFAULT_PALETTE).sort());
  });

  it('couvrent toutes les classes que la légende sait nommer', () => {
    for (const code of Object.keys(CLASS_NAMES)) {
      expect(DEFAULT_PALETTE[code], `classe ${code} absente de la palette de lecture`).toBeDefined();
      expect(MODEL_PALETTE[code], `classe ${code} absente de la palette maquette`).toBeDefined();
    }
  });

  it('ne contiennent que des triplets d’octets valides, listes comprises', () => {
    // Une entrée est soit une couleur, soit une liste de couleurs. Ne valider
    // que la première forme laisserait passer n'importe quoi dans la seconde.
    const verifier = (couleur, ou) => {
      expect(couleur, ou).toHaveLength(3);
      for (const canal of couleur) {
        expect(Number.isInteger(canal), `${ou}: ${canal} entier`).toBe(true);
        expect(canal, ou).toBeGreaterThanOrEqual(0);
        expect(canal, ou).toBeLessThanOrEqual(255);
      }
    };
    for (const name of PRESET_NAMES) {
      for (const [code, entree] of Object.entries(PRESETS[name].palette)) {
        const liste = Array.isArray(entree[0]) ? entree : [entree];
        expect(liste.length, `${name}/${code}: liste non vide`).toBeGreaterThan(0);
        liste.forEach((c, i) => verifier(c, `${name}/${code}[${i}]`));
      }
    }
  });

  it('éclaircit CHAQUE classe, et pas seulement en moyenne', () => {
    // C'est le parti pris du mode : la couleur se retire pour laisser le relief
    // porter la lisibilité, et l'ombrage de profondeur a besoin de marge pour
    // creuser. Une moyenne ne suffit pas à le garantir : assombrir une seule
    // classe se noie dans les onze autres et passe inaperçu.
    const luminance = (rgb) => 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    for (const code of Object.keys(DEFAULT_PALETTE)) {
      expect(
        luminance(MODEL_PALETTE[code]),
        `classe ${code} plus sombre en maquette qu'en lecture`,
      ).toBeGreaterThan(luminance(DEFAULT_PALETTE[code]));
    }
  });
});

describe('réglages du diorama', () => {
  it('gardent un rayon assez large pour lire les structures', () => {
    // En dessous de ~2 texels, l'ombrage suit le contour de chaque point et le
    // rendu part en billes au lieu de dégager les volumes.
    expect(DIORAMA_DEFAULTS.radius).toBeGreaterThanOrEqual(2);
  });

  it('restent dans des bornes qui produisent une image regardable', () => {
    expect(DIORAMA_DEFAULTS.strength).toBeGreaterThan(0);
    expect(DIORAMA_DEFAULTS.saturation).toBeGreaterThanOrEqual(1);
    expect(DIORAMA_DEFAULTS.vignette).toBeLessThan(0.5);
    expect(DIORAMA_DEFAULTS.tiltFocus).toBeGreaterThan(0);
    expect(DIORAMA_DEFAULTS.tiltFocus).toBeLessThan(1);
    expect(DIORAMA_DEFAULTS.tiltAmount).toBeLessThanOrEqual(1);
  });
});

describe('direction de la lumière', () => {
  it('place la source selon un azimut de carte : nord en haut, est à droite', () => {
    const [xn, yn] = lightVector(0, 0);
    expect(yn).toBeCloseTo(1); // nord : vers le haut de l'image
    expect(xn).toBeCloseTo(0);

    const [xe] = lightVector(90, 0);
    expect(xe).toBeCloseTo(1); // est : vers la droite

    const [xo] = lightVector(270, 0);
    expect(xo).toBeCloseTo(-1); // ouest : vers la gauche
  });

  it('fait monter la source vers l’observateur avec la hauteur', () => {
    expect(lightVector(315, 0)[2]).toBeCloseTo(0);
    expect(lightVector(315, 90)[2]).toBeCloseTo(1);
    expect(lightVector(315, 45)[2]).toBeCloseTo(Math.SQRT1_2);
  });

  it('rend toujours un vecteur unitaire', () => {
    for (const [az, el] of [[0, 0], [45, 30], [180, 60], [315, 48], [270, 89]]) {
      const v = lightVector(az, el);
      expect(Math.hypot(...v)).toBeCloseTo(1, 9);
    }
  });

  it('oppose exactement deux azimuts opposés', () => {
    const a = lightVector(90, 40);
    const b = lightVector(270, 40);
    expect(a[0]).toBeCloseTo(-b[0]);
    expect(a[1]).toBeCloseTo(-b[1]);
    expect(a[2]).toBeCloseTo(b[2]); // même hauteur
  });
});

describe('presets d’affichage', () => {
  it('exposent tous un libellé, une palette et un fond', () => {
    expect(PRESET_NAMES.length).toBeGreaterThanOrEqual(3);
    for (const name of PRESET_NAMES) {
      const preset = PRESETS[name];
      expect(preset.label, `${name}: libellé`).toBeTruthy();
      expect(preset.palette, `${name}: palette`).toBeTruthy();
      expect(typeof preset.background, `${name}: fond`).toBe('number');
    }
  });

  it('couvrent toutes les classes nommées, dans chaque preset', () => {
    // Un code manquant dans une seule palette rend la classe grise au moment où
    // l'on bascule dessus : elle disparaît à l'œil sans erreur ni message.
    for (const name of PRESET_NAMES) {
      for (const code of Object.keys(CLASS_NAMES)) {
        expect(PRESETS[name].palette[code], `${name}: classe ${code}`).toBeDefined();
      }
    }
  });

  it('n’utilisent que des formes de découpe connues', () => {
    for (const name of PRESET_NAMES) {
      expect([null, undefined, 'circle', 'square']).toContain(PRESETS[name].shape);
    }
  });

  it('donnent un socle et un rayon à tout preset qui découpe', () => {
    // Découper sans socle laisse un nuage amputé qui flotte ; découper sans
    // rayon désactive silencieusement la découpe.
    for (const name of PRESET_NAMES) {
      const preset = PRESETS[name];
      if (!preset.shape) continue;
      expect(preset.radius, `${name}: rayon`).toBeGreaterThan(0);
      expect(typeof preset.plinth, `${name}: socle`).toBe('number');
    }
  });

  it('accompagnent tout post-traitement de ses réglages', () => {
    for (const name of PRESET_NAMES) {
      const preset = PRESETS[name];
      if (!preset.post) continue;
      expect(preset.diorama, `${name}: réglages`).toBeTruthy();
      expect(preset.diorama.radius, `${name}: rayon d'ombrage`).toBeGreaterThanOrEqual(2);
    }
  });

  it('laisse le mode lecture sans découpe ni post-traitement', () => {
    expect(PRESETS.lecture.shape ?? null).toBeNull();
    expect(PRESETS.lecture.post).toBeFalsy();
  });

  it('rend le preset de repli sur un nom inconnu', () => {
    expect(getPreset('nexistepas')).toBe(PRESETS.lecture);
  });
});
