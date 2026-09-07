import { describe, expect, it } from 'vitest';
import {
  LIDAR_HD_PRECISION,
  formatDistance,
  formatSlope,
  measureBetween,
  measurementUncertainty,
  toAbsolute,
} from '../src/analysis/measure.js';
import { unpackDepth } from '../src/render/picker.js';

describe('coordonnées absolues', () => {
  it('replace un point de la scène dans le repère Lambert-93', () => {
    // Une mesure qui ne peut pas se reporter sur une carte ne sert à rien.
    const abs = toAbsolute({ x: -120, y: 45, z: -430 }, [574500, 6279500, 632.3]);
    expect(abs.x).toBeCloseTo(574380);
    expect(abs.y).toBeCloseTo(6279545);
    expect(abs.z).toBeCloseTo(202.3);
  });
});

describe('mesure entre deux points', () => {
  it('sépare distance 3D, distance horizontale et dénivelé', () => {
    // Triangle 3-4-5 à plat, puis 5-12-13 avec le dénivelé.
    const m = measureBetween({ x: 0, y: 0, z: 100 }, { x: 3, y: 4, z: 112 });
    expect(m.horizontal).toBeCloseTo(5);
    expect(m.dz).toBeCloseTo(12);
    expect(m.distance).toBeCloseTo(13);
  });

  it('donne la pente en pourcentage ET en degrés, qui ne sont pas la même chose', () => {
    // 100 % vaut 45°, pas 90 : la confusion est courante et coûteuse.
    const m = measureBetween({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 10 });
    expect(m.slopePercent).toBeCloseTo(100);
    expect(m.slopeDegrees).toBeCloseTo(45);

    const douce = measureBetween({ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 5 });
    expect(douce.slopePercent).toBeCloseTo(5);
    expect(douce.slopeDegrees).toBeCloseTo(2.862, 2);
  });

  it('compte une pente descendante en négatif', () => {
    const m = measureBetween({ x: 0, y: 0, z: 20 }, { x: 10, y: 0, z: 10 });
    expect(m.dz).toBeCloseTo(-10);
    expect(m.slopePercent).toBeCloseTo(-100);
    expect(m.slopeDegrees).toBeCloseTo(-45);
    expect(m.distance).toBeGreaterThan(0);
  });

  it('assume la verticale plutôt que de diviser par zéro', () => {
    const m = measureBetween({ x: 5, y: 5, z: 0 }, { x: 5, y: 5, z: 30 });
    expect(m.horizontal).toBe(0);
    expect(m.slopePercent).toBe(Infinity);
    expect(m.slopeDegrees).toBe(90);
    expect(Number.isNaN(m.azimuth)).toBe(true); // aucune direction à donner
    expect(m.distance).toBeCloseTo(30);
  });

  it('rend une pente nulle pour deux points confondus, pas un infini', () => {
    const m = measureBetween({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 });
    expect(m.distance).toBe(0);
    expect(m.slopePercent).toBe(0);
    expect(m.slopeDegrees).toBe(0);
  });

  it('mesure l’azimut depuis le nord de la projection', () => {
    expect(measureBetween({ x: 0, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }).azimuth).toBeCloseTo(0);
    expect(measureBetween({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }).azimuth).toBeCloseTo(90);
    expect(measureBetween({ x: 0, y: 0, z: 0 }, { x: 0, y: -10, z: 0 }).azimuth).toBeCloseTo(180);
    expect(measureBetween({ x: 0, y: 0, z: 0 }, { x: -10, y: 0, z: 0 }).azimuth).toBeCloseTo(270);
  });
});

describe('mise en forme', () => {
  it('n’affiche pas plus de précision que la donnée n’en a', () => {
    // Le LiDAR HD est donné pour une dizaine de centimètres en altimétrie.
    expect(formatDistance(3.14159)).toBe('3.14 m');
    expect(formatDistance(42.987)).toBe('43.0 m');
    expect(formatDistance(1500)).toBe('1.50 km');
    expect(formatDistance(NaN)).toBe('—');
  });

  it('nomme la verticale au lieu d’écrire un infini', () => {
    expect(formatSlope(Infinity, 90)).toBe('verticale');
    expect(formatSlope(12.34, 7.03)).toBe('12.3 % · 7.0°');
  });
});

describe('dépaquetage de la profondeur', () => {
  it('retrouve 0 et 1 aux extrêmes', () => {
    expect(unpackDepth(0, 0, 0, 0)).toBeCloseTo(0, 6);
    expect(unpackDepth(255, 255, 255, 255)).toBeCloseTo(1, 5);
  });

  it('est monotone sur le canal de poids fort', () => {
    const suite = [60, 120, 200, 254].map((r) => unpackDepth(r, 0, 0, 0));
    for (let i = 1; i < suite.length; i += 1) expect(suite[i]).toBeGreaterThan(suite[i - 1]);
  });

  it('place le poids fort dans le ROUGE, comme Three le fait', () => {
    // Le piège : l'ordre inverse a longtemps prévalu et se trouve encore
    // partout. Il décode sans erreur une valeur entièrement fausse. Ce test
    // fixe la convention sur une valeur que l'on peut vérifier à la main :
    // packDepthToRGBA(0.75) rend [192, 0, 0, 0], car 0,75 x 256 = 192.
    expect(unpackDepth(192, 0, 0, 0)).toBeCloseTo(0.75, 6);
    expect(unpackDepth(128, 0, 0, 0)).toBeCloseTo(0.5, 6);
    // Et un pas sur le rouge pèse bien plus qu'un pas sur l'alpha.
    expect(unpackDepth(1, 0, 0, 0)).toBeGreaterThan(unpackDepth(0, 0, 0, 255) * 1000);
  });
});

describe('ce que vaut une mesure', () => {
  it('ajoute l’échantillonnage à l’exactitude annoncée', () => {
    // Les deux termes sont indépendants : somme quadratique, pas addition.
    // À 3 m d'espacement, l'échantillonnage (1,5 m) pèse trois fois les 50 cm
    // de planimétrie — c'est lui qui décide, et c'est ce qu'il faut montrer.
    const u = measurementUncertainty(3);
    expect(u.horizontalPoint).toBeCloseTo(Math.hypot(0.5, 1.5), 6);
    expect(u.horizontalPoint).toBeGreaterThan(LIDAR_HD_PRECISION.planimetrie);
    expect(u.verticalPoint).toBe(LIDAR_HD_PRECISION.altimetrie);
  });

  it('cumule l’incertitude des deux extrémités d’une distance', () => {
    const u = measurementUncertainty(3);
    expect(u.horizontalDistance).toBeCloseTo(u.horizontalPoint * Math.SQRT2, 6);
    expect(u.verticalDistance).toBeCloseTo(u.verticalPoint * Math.SQRT2, 6);
    expect(u.horizontalDistance).toBeGreaterThan(u.horizontalPoint);
  });

  it('retombe sur la seule exactitude annoncée sans espacement connu', () => {
    // Sans niveau de détail identifiable, on n'invente pas un terme : on donne
    // le plancher, et `spacing` reste NaN pour que l'interface le dise.
    for (const absent of [NaN, 0, -1, undefined]) {
      const u = measurementUncertainty(absent);
      expect(Number.isNaN(u.spacing), String(absent)).toBe(true);
      expect(u.horizontalPoint).toBeCloseTo(LIDAR_HD_PRECISION.planimetrie, 6);
    }
  });

  it('grandit avec l’espacement, sans jamais descendre sous le plancher', () => {
    const suite = [0.5, 1, 2, 4, 8].map((s) => measurementUncertainty(s).horizontalPoint);
    for (let i = 1; i < suite.length; i += 1) expect(suite[i]).toBeGreaterThan(suite[i - 1]);
    expect(suite[0]).toBeGreaterThanOrEqual(LIDAR_HD_PRECISION.planimetrie);
  });

  it('reste sous le mètre au pas natif du LiDAR HD', () => {
    // 10 pts/m² annoncés, soit ~30 cm d'espacement au niveau le plus fin :
    // l'incertitude en plan doit alors être dominée par les 50 cm du producteur.
    const u = measurementUncertainty(0.32);
    expect(u.horizontalPoint).toBeLessThan(0.6);
  });
});
