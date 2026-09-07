import { describe, expect, it } from 'vitest';
import { HEADER_PROBE_SIZE, averageDensity, parseCopcHeader } from '../src/copc/header.js';
import { ENTRY_SIZE, loadHierarchy, parseHierarchyPage, summarise } from '../src/copc/hierarchy.js';

/**
 * Fabrique 2 Ko d'en-tête COPC. Les valeurs sont volontairement dissymétriques
 * (X, Y et Z tous différents, min et max jamais interchangeables) pour qu'une
 * lecture au mauvais décalage ou dans le mauvais ordre soit visible.
 */
function buildHeader(overrides = {}) {
  const opts = {
    pointFormatRaw: 0x86, // format 6, compressé
    pointLength: 30,
    pointCount: 31_416_352,
    minX: 573_000,
    maxX: 574_000,
    minY: 6_277_000,
    maxY: 6_278_000,
    minZ: 132.3,
    maxZ: 192.7,
    spacing: 6.803,
    rootHierOffset: 171_025_725,
    rootHierSize: 44_416,
    userId: 'copc',
    recordId: 1,
    ...overrides,
  };

  const bytes = new Uint8Array(HEADER_PROBE_SIZE);
  const dv = new DataView(bytes.buffer);
  bytes.set([0x4c, 0x41, 0x53, 0x46], 0); // "LASF"
  dv.setUint8(24, 1);
  dv.setUint8(25, 4);
  dv.setUint16(94, 375, true);
  dv.setUint32(96, 1418, true);
  dv.setUint32(100, 3, true);
  dv.setUint8(104, opts.pointFormatRaw);
  dv.setUint16(105, opts.pointLength, true);
  for (let i = 0; i < 3; i += 1) dv.setFloat64(131 + i * 8, 0.01, true);
  dv.setFloat64(155, 0, true);
  dv.setFloat64(163, 0, true);
  dv.setFloat64(171, 0, true);

  // Ordre du format LAS : max avant min, axe par axe.
  dv.setFloat64(179, opts.maxX, true);
  dv.setFloat64(187, opts.minX, true);
  dv.setFloat64(195, opts.maxY, true);
  dv.setFloat64(203, opts.minY, true);
  dv.setFloat64(211, opts.maxZ, true);
  dv.setFloat64(219, opts.minZ, true);

  dv.setBigUint64(247, BigInt(opts.pointCount), true);

  for (let i = 0; i < opts.userId.length; i += 1) dv.setUint8(375 + 2 + i, opts.userId.charCodeAt(i));
  dv.setUint16(375 + 18, opts.recordId, true);
  dv.setUint16(375 + 20, 160, true);

  const d = 375 + 54;
  dv.setFloat64(d, 573_500, true);
  dv.setFloat64(d + 8, 6_277_500, true);
  dv.setFloat64(d + 16, 632.3, true);
  dv.setFloat64(d + 24, 500, true);
  dv.setFloat64(d + 32, opts.spacing, true);
  dv.setBigUint64(d + 40, BigInt(opts.rootHierOffset), true);
  dv.setBigInt64(d + 48, BigInt(opts.rootHierSize), true);
  return bytes;
}

describe('parseCopcHeader', () => {
  it('lit les champs principaux', () => {
    const h = parseCopcHeader(buildHeader());
    expect(h.pointFormat).toBe(6); // 0x86 -> 6, le bit haut ne dit que la compression
    expect(h.compressed).toBe(true);
    expect(h.pointLength).toBe(30);
    expect(h.pointCount).toBe(31_416_352);
    expect(h.spacing).toBeCloseTo(6.803, 3);
    expect(h.rootHierOffset).toBe(171_025_725);
    expect(h.rootHierSize).toBe(44_416);
  });

  it('rend une emprise positive malgré l ordre max-avant-min du format LAS', () => {
    // Le piège : lire ces six doubles dans l'ordre intuitif donne une emprise
    // négative — « -1000 x -1000 m » — qui ne lève rien et contamine ensuite
    // tout calcul d'échelle.
    const h = parseCopcHeader(buildHeader());
    expect(h.bounds.minX).toBe(573_000);
    expect(h.bounds.maxX).toBe(574_000);
    expect(h.bounds.maxX - h.bounds.minX).toBeGreaterThan(0);
    expect(h.bounds.maxY - h.bounds.minY).toBeGreaterThan(0);
    expect(h.bounds.maxZ).toBeCloseTo(192.7, 1);
    expect(h.bounds.minZ).toBeCloseTo(132.3, 1);
  });

  it('calcule une densité plausible', () => {
    expect(averageDensity(parseCopcHeader(buildHeader()))).toBeCloseTo(31.4, 1);
  });

  it('refuse un fichier qui n est pas du COPC', () => {
    expect(() => parseCopcHeader(buildHeader({ userId: 'laszip encoded' }))).toThrow(/pas un COPC/);
    expect(() => parseCopcHeader(buildHeader({ recordId: 22 }))).toThrow(/pas un COPC/);
  });

  it('refuse une signature ou une version inattendue', () => {
    const noSig = buildHeader();
    noSig.set([0x4a, 0x55, 0x4e, 0x4b], 0);
    expect(() => parseCopcHeader(noSig)).toThrow(/signature/);

    const wrongVersion = buildHeader();
    new DataView(wrongVersion.buffer).setUint8(25, 2);
    expect(() => parseCopcHeader(wrongVersion)).toThrow(/1\.2 non géré/);
  });

  it('refuse un en-tête tronqué au lieu de lire au-delà', () => {
    expect(() => parseCopcHeader(new Uint8Array(500))).toThrow(/tronqué/);
  });
});

function buildPage(entries) {
  const bytes = new Uint8Array(entries.length * ENTRY_SIZE);
  const dv = new DataView(bytes.buffer);
  entries.forEach((e, i) => {
    const o = i * ENTRY_SIZE;
    dv.setInt32(o, e.level, true);
    dv.setInt32(o + 4, e.x ?? 0, true);
    dv.setInt32(o + 8, e.y ?? 0, true);
    dv.setInt32(o + 12, e.z ?? 0, true);
    dv.setBigUint64(o + 16, BigInt(e.offset), true);
    dv.setInt32(o + 24, e.byteSize, true);
    dv.setInt32(o + 28, e.pointCount, true);
  });
  return bytes;
}

describe('parseHierarchyPage', () => {
  it('sépare les nœuds, les sous-pages et les nœuds vides', () => {
    const page = buildPage([
      { level: 0, offset: 1000, byteSize: 500, pointCount: 42 },
      { level: 1, x: 1, offset: 2000, byteSize: 600, pointCount: -1 }, // sous-page
      { level: 1, x: 2, offset: 3000, byteSize: 0, pointCount: 0 }, // nœud vide
    ]);
    const { nodes, childPages } = parseHierarchyPage(page);

    expect(nodes).toHaveLength(1);
    expect(nodes[0].pointCount).toBe(42);
    expect(nodes[0].id).toBe('0-0-0-0');
    expect(childPages).toHaveLength(1);
    expect(childPages[0].offset).toBe(2000);
  });

  it('refuse une page de taille non multiple de 32', () => {
    expect(() => parseHierarchyPage(new Uint8Array(33))).toThrow(/malformée/);
    expect(() => parseHierarchyPage(new Uint8Array(0))).toThrow(/malformée/);
  });
});

describe('loadHierarchy', () => {
  it('suit les sous-pages et respecte le niveau maximal', async () => {
    const root = buildPage([
      { level: 0, offset: 10, byteSize: 100, pointCount: 5 },
      { level: 1, x: 1, offset: 900, byteSize: ENTRY_SIZE, pointCount: -1 },
    ]);
    const child = buildPage([{ level: 1, x: 1, offset: 20, byteSize: 200, pointCount: 7 }]);

    const reads = [];
    const readPage = async (offset, size) => {
      reads.push(offset);
      return offset === 900 ? child : root;
    };

    const header = { rootHierOffset: 0, rootHierSize: root.length };
    const { nodes, pagesRead } = await loadHierarchy(header, readPage, { maxLevel: 2 });

    expect(pagesRead).toBe(2);
    expect(reads).toEqual([0, 900]);
    expect(nodes.map((n) => n.pointCount).sort((a, b) => a - b)).toEqual([5, 7]);
  });

  it('ne descend pas dans les sous-pages au-delà du niveau demandé', async () => {
    const root = buildPage([
      { level: 0, offset: 10, byteSize: 100, pointCount: 5 },
      { level: 3, x: 1, offset: 900, byteSize: ENTRY_SIZE, pointCount: -1 },
    ]);
    const reads = [];
    const readPage = async (offset) => {
      reads.push(offset);
      return root;
    };
    const { nodes } = await loadHierarchy({ rootHierOffset: 0, rootHierSize: root.length }, readPage, {
      maxLevel: 1,
    });
    expect(reads).toEqual([0]); // la sous-page de niveau 3 n'est jamais lue
    expect(nodes).toHaveLength(1);
  });
});

describe('summarise', () => {
  it('agrège par niveau et conserve le total', () => {
    const nodes = [
      { key: { level: 0 }, pointCount: 10, byteSize: 100 },
      { key: { level: 1 }, pointCount: 20, byteSize: 200 },
      { key: { level: 1 }, pointCount: 5, byteSize: 50 },
    ];
    const levels = summarise(nodes);
    expect(levels).toHaveLength(2);
    expect(levels[1]).toMatchObject({ level: 1, nodes: 2, points: 25, bytes: 250 });
    expect(levels.reduce((a, l) => a + l.points, 0)).toBe(35);
  });
});
