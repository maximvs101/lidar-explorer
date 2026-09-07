import { describe, expect, it } from 'vitest';
import { COLOR_MODES, DEFAULT_PALETTE, NEUTRAL_PALETTE, PointsMaterialPool }
  from '../src/render/pointsMaterial.js';
import { RELIEF_DEFAULTS, lightVector } from '../src/render/relief.js';
import { PRESETS, PRESET_NAMES, getPreset } from '../src/render/presets.js';
import { CLASS_NAMES } from '../src/analysis/classStats.js';

describe('palettes', () => {
  it('couvrent exactement les mêmes classes', () => {
    // Un code présent d'un côté seulement passerait au gris de repli en changeant
    // de mode, sans erreur ni message : la classe existe encore dans la légende
    // mais devient invisible à l'œil.
    expect(Object.keys(NEUTRAL_PALETTE).sort()).toEqual(Object.keys(DEFAULT_PALETTE).sort());
  });

  it('couvrent toutes les classes que la légende sait nommer', () => {
    for (const code of Object.keys(CLASS_NAMES)) {
      expect(DEFAULT_PALETTE[code], `classe ${code} absente de la palette de lecture`).toBeDefined();
      expect(NEUTRAL_PALETTE[code], `classe ${code} absente de la palette neutre`).toBeDefined();
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
    // La palette neutre sert de fond aux modes d'analyse : elle doit laisser la
    // place au relief et aux rampes de hauteur, donc rester plus claire que le
    // nuancier technique. Une moyenne ne suffit pas à le garantir : assombrir
    // une seule classe se noie dans les onze autres et passe inaperçu.
    const luminance = (rgb) => 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    for (const code of Object.keys(DEFAULT_PALETTE)) {
      expect(
        luminance(NEUTRAL_PALETTE[code]),
        `classe ${code} plus sombre en palette neutre qu'en lecture`,
      ).toBeGreaterThan(luminance(DEFAULT_PALETTE[code]));
    }
  });
});

describe('réglages du diorama', () => {
  it('gardent un rayon assez large pour lire les structures', () => {
    // En dessous de ~2 texels, l'ombrage suit le contour de chaque point et le
    // rendu part en billes au lieu de dégager les volumes.
    expect(RELIEF_DEFAULTS.radius).toBeGreaterThanOrEqual(2);
  });

  it('restent dans des bornes qui produisent une image lisible', () => {
    expect(RELIEF_DEFAULTS.strength).toBeGreaterThan(0);
    expect(RELIEF_DEFAULTS.lightAmount).toBeGreaterThanOrEqual(0);
    expect(RELIEF_DEFAULTS.lightAmount).toBeLessThanOrEqual(1);
    expect(RELIEF_DEFAULTS.lightAltitude).toBeGreaterThan(0);
    expect(RELIEF_DEFAULTS.lightAltitude).toBeLessThan(90);
    // Six texels : en deçà, le gradient de profondeur ne mesure que le bruit
    // entre points voisins, pas une surface.
    expect(RELIEF_DEFAULTS.lightSpread).toBeGreaterThanOrEqual(4);
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



  it('accompagnent tout relief de ses réglages', () => {
    for (const name of PRESET_NAMES) {
      const preset = PRESETS[name];
      if (!preset.post) continue;
      expect(preset.relief, `${name}: réglages`).toBeTruthy();
      expect(preset.relief.radius, `${name}: rayon d'ombrage`).toBeGreaterThanOrEqual(2);
    }
  });

  it('laisse le mode lecture sans post-traitement', () => {
    expect(PRESETS.lecture.post).toBeFalsy();
  });

  it('nomme une source de couleur connue', () => {
    for (const name of PRESET_NAMES) {
      expect(Object.keys(COLOR_MODES)).toContain(PRESETS[name].colorMode ?? 'classe');
    }
  });

  it('rend le preset de repli sur un nom inconnu', () => {
    expect(getPreset('nexistepas')).toBe(PRESETS.lecture);
  });
});

describe('réglages d’affichage et presets', () => {
  it('aucun preset n’impose la taille ni la forme des points', () => {
    // Taille et forme sont des préférences d'affichage : un preset qui les
    // déclare les écrase au moment où l'on bascule dessus, et l'on perd son
    // réglage juste en comparant deux rendus. Si un preset doit vraiment les
    // imposer un jour, ce test est l'endroit où l'assumer.
    for (const name of PRESET_NAMES) {
      const preset = PRESETS[name];
      expect(preset.boost, `${name} impose une taille de points`).toBeUndefined();
      expect(preset.round, `${name} impose la forme des points`).toBeUndefined();
    }
  });

  it('ne fixe pas non plus le seuil de détail', () => {
    // Même raison : il commande le volume chargé, c'est un arbitrage de
    // l'utilisateur entre finesse et mémoire, pas une propriété de style.
    for (const name of PRESET_NAMES) {
      expect(PRESETS[name].minScreenError, `${name}`).toBeUndefined();
    }
  });
});

describe('codes des modes de coloration', () => {
  // Le shader compare un float au code du mode. Ces codes étaient écrits deux
  // fois — dans la table et à la main dans le GLSL — et retirer un mode du
  // milieu décalait tous les suivants sans que rien ne le signale : chaque mode
  // affichait alors celui d'à côté. Ils sont maintenant injectés depuis la
  // table, et ces contrôles vérifient qu'ils le restent.
  const source = () => new PointsMaterialPool().forSize(1).vertexShader;

  it('sont uniques et contigus depuis zéro', () => {
    const codes = Object.values(COLOR_MODES).sort((a, b) => a - b);
    expect(codes).toEqual(codes.map((_, i) => i));
  });

  it('laisse la classe en mode par défaut', () => {
    // Le rendu retombe sur la couleur de classe dès qu'un mode n'est pas
    // servable ; ce repli n'a de sens que si son code est le zéro initial.
    expect(COLOR_MODES.classe).toBe(0);
    expect(new PointsMaterialPool().shared.uColorMode).toBe(COLOR_MODES.classe);
  });

  it('écrit dans le shader le code que porte la table', () => {
    const glsl = source();
    for (const nom of ['hauteur', 'intensite', 'retours', 'bande']) {
      const attendu = `abs(uColorMode - ${COLOR_MODES[nom].toFixed(1)}) < 0.5`;
      expect(glsl, `garde du mode ${nom}`).toContain(attendu);
    }
  });

  it('n’a pas gardé de comparaison écrite à la main', () => {
    // Un seuil resté en dur survivrait à une renumérotation de la table.
    expect(source()).not.toMatch(/uColorMode\s*[<>]/);
  });

  it('donne une garde distincte à chaque mode coloré', () => {
    const glsl = source();
    const gardes = [...glsl.matchAll(/abs\(uColorMode - ([\d.]+)\) < 0\.5/g)].map((m) => m[1]);
    expect(new Set(gardes).size).toBe(gardes.length);
    // La classe n'a pas de garde : c'est ce qui reste quand aucune ne prend.
    expect(gardes).not.toContain(COLOR_MODES.classe.toFixed(1));
  });
});

describe('mode hauteur et terrain', () => {
  // Sans modèle de terrain, la hauteur au-dessus du sol n'existe pas : le
  // shader peindrait tout en gris « terrain inconnu », ce qui ressemble à un
  // rendu raté plutôt qu'à un mode indisponible. Le rendu retombe donc sur la
  // couleur de classe, et l'interface relit le mode réellement appliqué.
  const grille = () => ({
    cells: 2, size: 100, minX: -50, minY: -50,
    height: new Float32Array([1, 2, 3, 4]),
    known: new Uint8Array([1, 1, 1, 1]),
  });

  it('refuse la hauteur tant qu’aucun terrain n’est publié', () => {
    const pool = new PointsMaterialPool();
    pool.setColorMode('hauteur');
    expect(pool.shared.uColorMode).toBe(COLOR_MODES.classe);
  });

  it('l’accepte dès qu’un terrain est publié, et la reprend s’il disparaît', () => {
    // Les deux sens : un contrôle qui ne peut pas basculer ne prouve rien.
    const pool = new PointsMaterialPool();
    pool.setTerrain(grille());
    pool.setColorMode('hauteur');
    expect(pool.shared.uColorMode).toBe(COLOR_MODES.hauteur);

    pool.setTerrain(null);
    pool.setColorMode('hauteur');
    expect(pool.shared.uColorMode).toBe(COLOR_MODES.classe);
  });

  it('laisse passer les modes qui ne demandent pas de terrain', () => {
    const pool = new PointsMaterialPool();
    for (const mode of ['intensite', 'retours', 'bande']) {
      pool.setColorMode(mode);
      expect(pool.shared.uColorMode, mode).toBe(COLOR_MODES[mode]);
    }
  });

  it('retombe sur la classe pour un mode inconnu', () => {
    const pool = new PointsMaterialPool();
    pool.setColorMode('nexistepas');
    expect(pool.shared.uColorMode).toBe(COLOR_MODES.classe);
  });
});

describe('filtres de rendu', () => {
  const terrainPlat = () => ({
    cells: 2, size: 100, minX: -50, minY: -50,
    height: new Float32Array([10, 10, 10, 10]),
    known: new Uint8Array([1, 1, 1, 1]),
  });

  it('refuse le filtre de hauteur sans terrain publié', () => {
    // Sans terrain, le filtre écarterait tout : une scène vide sans explication
    // ressemble à une panne. On refuse, et l'appelant l'apprend par le retour.
    const pool = new PointsMaterialPool();
    expect(pool.setHeightFilter(2, 5)).toBe(false);
    expect(pool.shared.uHeightFilter).toBe(0);
  });

  it('l’accepte dès qu’un terrain est là, et le rend au retrait du terrain', () => {
    const pool = new PointsMaterialPool();
    pool.setTerrain(terrainPlat());
    expect(pool.setHeightFilter(2, 5)).toBe(true);
    expect(pool.shared.uHeightFilter).toBe(1);
    expect(pool.shared.uHeightRange).toEqual([2, 5]);

    pool.setTerrain(null);
    expect(pool.setHeightFilter(2, 5)).toBe(false);
  });

  it('remet les bornes dans l’ordre plutôt que de ne rien montrer', () => {
    const pool = new PointsMaterialPool();
    pool.setTerrain(terrainPlat());
    pool.setHeightFilter(9, 3);
    expect(pool.shared.uHeightRange).toEqual([3, 9]);
  });

  it('s’éteint sans toucher aux bornes retenues', () => {
    const pool = new PointsMaterialPool();
    pool.setTerrain(terrainPlat());
    pool.setHeightFilter(2, 5);
    expect(pool.setHeightFilter(2, 5, false)).toBe(false);
    expect(pool.shared.uHeightFilter).toBe(0);
    expect(pool.shared.uHeightRange).toEqual([2, 5]);
  });

  it('refuse une borne non finie', () => {
    const pool = new PointsMaterialPool();
    pool.setTerrain(terrainPlat());
    expect(pool.setHeightFilter(NaN, 5)).toBe(false);
    expect(pool.setHeightFilter(2, Infinity)).toBe(false);
  });

  it('la coupe s’éteint par une largeur nulle, pas par un interrupteur de plus', () => {
    const pool = new PointsMaterialPool();
    expect(pool.setSection([0, 0], [10, 0], 4)).toBe(true);
    expect(pool.shared.uSection).toEqual([0, 0, 10, 0]);
    expect(pool.shared.uSectionWidth).toBe(4);

    expect(pool.setSection([0, 0], [10, 0], 0)).toBe(false);
    expect(pool.shared.uSectionWidth).toBe(0);
    // Le segment retenu ne bouge pas : rallumer ne demande pas de le repasser.
    expect(pool.shared.uSection).toEqual([0, 0, 10, 0]);
  });

  it('la coupe refuse un segment absent ou une largeur absurde', () => {
    const pool = new PointsMaterialPool();
    expect(pool.setSection(null, [1, 1], 5)).toBe(false);
    expect(pool.setSection([0, 0], null, 5)).toBe(false);
    expect(pool.setSection([0, 0], [1, 1], -3)).toBe(false);
    expect(pool.setSection([0, 0], [1, 1], NaN)).toBe(false);
  });

  it('le shader porte les deux filtres, et un seul rejet en sortie', () => {
    const glsl = new PointsMaterialPool().forSize(1).vertexShader;
    expect(glsl).toContain('uHeightFilter > 0.5');
    expect(glsl).toContain('uSectionWidth > 0.0');
    // Un point écarté est renvoyé hors du volume de vue, une seule fois : deux
    // écritures concurrentes de gl_Position se masqueraient l'une l'autre.
    expect(glsl.match(/gl_Position = vec4\(2\.0/g)).toHaveLength(1);
  });
});
