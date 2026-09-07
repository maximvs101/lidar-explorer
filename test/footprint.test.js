import { describe, expect, it } from 'vitest';
import { horizontalHalfAngle, viewFootprint } from '../src/geo/footprint.js';

const RAD = Math.PI / 180;

describe('demi-angle horizontal', () => {
  it('vaut le demi-angle vertical sur un écran carré', () => {
    expect(horizontalHalfAngle(50 * RAD, 1)).toBeCloseTo(25 * RAD, 9);
  });

  it('s’élargit avec le rapport d’image', () => {
    // Three exprime son fov verticalement. Prendre le vertical pour l'horizontal
    // dessine un secteur trop étroit, d'autant plus faux que l'écran est large.
    const carre = horizontalHalfAngle(50 * RAD, 1);
    const large = horizontalHalfAngle(50 * RAD, 16 / 9);
    expect(large).toBeGreaterThan(carre);
    expect(large).toBeCloseTo(Math.atan(Math.tan(25 * RAD) * 16 / 9), 9);
  });
});

describe('empreinte au sol de la vue', () => {
  const base = { camera: [0, 0], target: [100, 0], fovRadians: 50 * RAD, aspect: 1 };

  it('part de la caméra et s’ouvre vers la cible', () => {
    const f = viewFootprint(base);
    expect(f.apex).toEqual([0, 0]);
    expect(f.polygon[0]).toEqual([0, 0]);
    expect(f.zenith).toBe(false);
    // Le milieu de l'arc est dans l'axe caméra → cible.
    const milieu = f.polygon[1 + Math.round((f.polygon.length - 2) / 2)];
    expect(Math.atan2(milieu[1], milieu[0])).toBeCloseTo(0, 6);
  });

  it('porte au-delà de la cible, jamais moins loin', () => {
    const f = viewFootprint(base);
    expect(f.reach).toBeCloseTo(135, 6);
    expect(f.reach).toBeGreaterThan(100);
  });

  it('suit l’azimut de la caméra vers la cible', () => {
    // Vers le nord : le secteur doit s'ouvrir vers les y croissants.
    const f = viewFootprint({ ...base, target: [0, 100] });
    const arc = f.polygon.slice(1);
    expect(Math.min(...arc.map((p) => p[1]))).toBeGreaterThan(0);
    expect(Math.max(...arc.map((p) => Math.abs(p[0])))).toBeLessThan(f.reach);
  });

  it('reste dans le demi-angle annoncé', () => {
    const f = viewFootprint({ ...base, aspect: 2 });
    const attendu = horizontalHalfAngle(50 * RAD, 2);
    for (const p of f.polygon.slice(1)) {
      expect(Math.abs(Math.atan2(p[1], p[0]))).toBeLessThanOrEqual(attendu + 1e-9);
    }
    // Et le secteur atteint bien ses bords, sinon il serait plus étroit qu'annoncé.
    const extreme = Math.max(...f.polygon.slice(1).map((p) => Math.abs(Math.atan2(p[1], p[0]))));
    expect(extreme).toBeCloseTo(attendu, 9);
  });

  it('devient un disque quand la caméra est à l’aplomb de sa cible', () => {
    // Vue au zénith : aucun azimut à montrer, mais une zone bien réelle.
    // Choisir une direction au hasard ferait croire à une orientation.
    const f = viewFootprint({ ...base, target: [0, 0] });
    expect(f.zenith).toBe(true);
    const rayons = f.polygon.map((p) => Math.hypot(p[0], p[1]));
    expect(Math.max(...rayons)).toBeCloseTo(Math.min(...rayons), 6);
    expect(f.polygon.length).toBeGreaterThan(8);
  });

  it('travaille en coordonnées absolues, sans rien recentrer', () => {
    const f = viewFootprint({ camera: [574500, 6279500], target: [574600, 6279500] });
    expect(f.apex).toEqual([574500, 6279500]);
    expect(f.target).toEqual([574600, 6279500]);
  });

  it('rend null sans caméra ni cible', () => {
    expect(viewFootprint({ camera: null, target: [0, 0] })).toBe(null);
    expect(viewFootprint({ camera: [0, 0], target: null })).toBe(null);
    expect(viewFootprint()).toBe(null);
  });
});
