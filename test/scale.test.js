import { describe, expect, it } from 'vitest';
import { cardinal, chooseScale, formatLength, pixelsPerMetre, viewAzimuth } from '../src/ui/scale.js';

describe('pixelsPerMetre', () => {
  it('décroît comme l’inverse de la distance', () => {
    const base = { viewportHeight: 900, fovRadians: (50 * Math.PI) / 180 };
    const proche = pixelsPerMetre({ ...base, distance: 100 });
    const loin = pixelsPerMetre({ ...base, distance: 400 });
    expect(proche / loin).toBeCloseTo(4, 6);
  });

  it('double quand la fenêtre double', () => {
    const a = pixelsPerMetre({ viewportHeight: 450, fovRadians: 0.87, distance: 200 });
    const b = pixelsPerMetre({ viewportHeight: 900, fovRadians: 0.87, distance: 200 });
    expect(b).toBeCloseTo(a * 2, 9);
  });

  it('rend zéro plutôt qu’un infini sur des entrées dégénérées', () => {
    expect(pixelsPerMetre({ viewportHeight: 900, fovRadians: 0.87, distance: 0 })).toBe(0);
    expect(pixelsPerMetre({ viewportHeight: 0, fovRadians: 0.87, distance: 10 })).toBe(0);
  });
});

describe('chooseScale', () => {
  it('choisit une longueur ronde dont la barre tient dans la plage', () => {
    const r = chooseScale({ pixelsPerMetre: 2 }); // 50 m -> 100 px
    expect([50, 20]).toContain(r.metres);
    expect(r.px).toBeGreaterThanOrEqual(60);
    expect(r.px).toBeLessThanOrEqual(150);
  });

  it('suit l’échelle sur plusieurs ordres de grandeur', () => {
    const grand = chooseScale({ pixelsPerMetre: 20 });   // très zoomé
    const petit = chooseScale({ pixelsPerMetre: 0.05 }); // vue large
    expect(grand.metres).toBeLessThan(petit.metres);
    for (const r of [grand, petit]) {
      expect(r.px).toBeGreaterThanOrEqual(60);
      expect(r.px).toBeLessThanOrEqual(150);
    }
  });

  it('rend quand même une barre quand aucune longueur ronde ne tombe juste', () => {
    const r = chooseScale({ pixelsPerMetre: 1e-6 });
    expect(r).not.toBeNull();
    expect(r.metres).toBeGreaterThan(0);
  });

  it('ne rend rien sans échelle exploitable', () => {
    expect(chooseScale({ pixelsPerMetre: 0 })).toBeNull();
  });
});

describe('azimut', () => {
  it('mesure depuis le nord vers l’est', () => {
    expect(viewAzimuth([0, 0], [0, 10])).toBeCloseTo(0); // vers le nord
    expect(viewAzimuth([0, 0], [10, 0])).toBeCloseTo(90); // vers l'est
    expect(viewAzimuth([0, 0], [0, -10])).toBeCloseTo(180);
    expect(viewAzimuth([0, 0], [-10, 0])).toBeCloseTo(270);
  });

  it('nomme les points cardinaux, y compris au repli de 360', () => {
    expect(cardinal(0)).toBe('N');
    expect(cardinal(90)).toBe('E');
    expect(cardinal(225)).toBe('SO');
    expect(cardinal(359)).toBe('N');
  });

  it('rend zéro plutôt qu’un NaN quand la caméra est sur sa cible', () => {
    expect(viewAzimuth([5, 5], [5, 5])).toBe(0);
  });
});

describe('formatLength', () => {
  it('passe au kilomètre au-delà de mille mètres', () => {
    expect(formatLength(200)).toBe('200 m');
    expect(formatLength(1000)).toBe('1 km');
    expect(formatLength(5000)).toBe('5 km');
  });
});
