import { describe, expect, it } from 'vitest';
import {
  addToSection,
  emptySection,
  sectionAxis,
  verticalBounds,
  verticalExaggeration,
} from '../src/analysis/section.js';

describe('axe de la coupe', () => {
  const axe = sectionAxis([0, 0], [100, 0]);

  it('mesure la distance le long et l’écart perpendiculaire', () => {
    expect(axe.length).toBeCloseTo(100);
    expect(axe.project(30, 0)).toEqual({ along: 30, offset: 0 });
    expect(axe.project(30, 4).offset).toBeCloseTo(4);
    expect(axe.project(30, -4).offset).toBeCloseTo(4);
  });

  it('borne l’abscisse au segment, sans prolonger la droite', () => {
    // Un point à 2 km derrière A n'appartient pas à la coupe : sans bornage,
    // la bande s'étendrait à l'infini le long de la droite porteuse.
    expect(axe.project(-2000, 0)).toEqual({ along: 0, offset: 2000 });
    expect(axe.project(300, 0)).toEqual({ along: 100, offset: 200 });
  });

  it('marche sur un segment oblique', () => {
    const oblique = sectionAxis([0, 0], [30, 40]);
    expect(oblique.length).toBeCloseTo(50);
    expect(oblique.project(15, 20).along).toBeCloseTo(25);
    expect(oblique.project(15, 20).offset).toBeCloseTo(0);
    // Perpendiculaire au milieu : 10 m de côté.
    expect(oblique.project(15 + 8, 20 - 6).offset).toBeCloseTo(10);
  });

  it('ne divise pas par zéro sur un segment dégénéré', () => {
    const nul = sectionAxis([5, 5], [5, 5]);
    expect(nul.length).toBe(0);
    const p = nul.project(8, 9);
    expect(Number.isFinite(p.along)).toBe(true);
    expect(p.offset).toBeCloseTo(5);
  });
});

describe('échantillonnage', () => {
  const axe = sectionAxis([0, 0], [100, 0]);
  const lot = (pts) => ({
    pos: new Float32Array(pts.flat()),
    cls: new Uint8Array(pts.map(() => 5)),
  });

  it('ne retient que ce qui est dans la bande', () => {
    const { pos, cls } = lot([[10, 0, 120], [20, 3, 121], [30, 9, 122], [40, -2, 123]]);
    const s = addToSection(emptySection(), axe, 8, pos, cls);
    expect(s.tested).toBe(4);
    expect(s.count).toBe(3); // l'écart de 9 m dépasse la demi-largeur de 4
    expect([...s.along.slice(0, 3)]).toEqual([10, 20, 40]);
  });

  it('retient les bornes verticales de ce qu’il garde, pas de tout', () => {
    // Le point écarté est le plus haut : le compter fausserait l'enveloppe.
    const { pos, cls } = lot([[10, 0, 100], [20, 50, 900], [30, 0, 140]]);
    const s = addToSection(emptySection(), axe, 4, pos, cls);
    expect(s.zMin).toBe(100);
    expect(s.zMax).toBe(140);
  });

  it('accumule sur plusieurs lots', () => {
    const s = emptySection();
    addToSection(s, axe, 10, ...Object.values(lot([[10, 0, 100]])));
    addToSection(s, axe, 10, ...Object.values(lot([[60, 0, 130]])));
    expect(s.count).toBe(2);
    expect(s.tested).toBe(2);
    expect(s.zMax).toBe(130);
  });

  it('annonce la troncature au lieu de la subir', () => {
    // Un profil tronqué en silence donne une enveloppe fausse — et c'est
    // justement l'enveloppe qu'on vient y lire.
    const s = emptySection(2);
    const { pos, cls } = lot([[1, 0, 100], [2, 0, 101], [3, 0, 102], [4, 0, 103]]);
    addToSection(s, axe, 10, pos, cls);
    expect(s.truncated).toBe(true);
    expect(s.count).toBe(2);
  });

  it('garde la classe de chaque point', () => {
    const pos = new Float32Array([10, 0, 100, 20, 0, 110]);
    const s = addToSection(emptySection(), axe, 10, pos, new Uint8Array([2, 6]));
    expect([...s.classification.slice(0, 2)]).toEqual([2, 6]);
  });
});

describe('bornes et exagération', () => {
  it('donne le facteur d’étirement vertical du tracé', () => {
    // 300 m de long, 30 m de dénivelé, dans 600 × 200 px : la verticale est
    // étirée d'un facteur 3,33. Presque aucun profil ne le dit.
    const f = verticalExaggeration({ length: 300, zSpan: 30, width: 600, height: 200 });
    expect(f).toBeCloseTo((200 / 30) / (600 / 300), 6);
    expect(f).toBeCloseTo(3.333, 3);
  });

  it('vaut 1 quand les deux échelles coïncident', () => {
    expect(verticalExaggeration({ length: 100, zSpan: 50, width: 200, height: 100 })).toBeCloseTo(1, 9);
  });

  it('refuse une exagération sur des dimensions absurdes', () => {
    for (const cas of [{ length: 0, zSpan: 1, width: 1, height: 1 },
                       { length: 1, zSpan: 0, width: 1, height: 1 },
                       { length: 1, zSpan: 1, width: 0, height: 1 }]) {
      expect(Number.isNaN(verticalExaggeration(cas))).toBe(true);
    }
  });

  it('marge les bornes verticales autour de la donnée', () => {
    const s = { ...emptySection(), count: 2, zMin: 100, zMax: 140 };
    const b = verticalBounds(s);
    expect(b.min).toBeLessThan(100);
    expect(b.max).toBeGreaterThan(140);
    expect(b.span).toBeCloseTo(40 * 1.1, 6);
  });

  it('impose une amplitude minimale sur une surface plane', () => {
    // Sans plancher, l'amplitude nulle donne une division par zéro et le
    // tracé s'effondre sur une ligne.
    const s = { ...emptySection(), count: 3, zMin: 120, zMax: 120 };
    const b = verticalBounds(s, { minSpan: 2 });
    expect(b.span).toBeCloseTo(2, 6);
    expect((b.min + b.max) / 2).toBeCloseTo(120, 6);
  });

  it('rend des bornes utilisables sur un échantillon vide', () => {
    const b = verticalBounds(emptySection());
    expect(Number.isFinite(b.min)).toBe(true);
    expect(b.span).toBeGreaterThan(0);
  });
});
