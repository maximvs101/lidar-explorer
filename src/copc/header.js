import { ProtocolError } from '../net/errors.js';

/** Les 2 Ko de tête suffisent : en-tête LAS (375 o) + VLR `copc info` (54+160 o). */
export const HEADER_PROBE_SIZE = 2048;

const LAS_HEADER_SIZE = 375;
const VLR_HEADER_SIZE = 54;

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function ascii(bytes, offset, length) {
  let s = '';
  for (let i = 0; i < length; i += 1) {
    const c = bytes[offset + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/**
 * Décode l'en-tête LAS 1.4 et la VLR `copc info` d'une dalle COPC.
 *
 * Piège du format LAS : les bornes sont rangées **max avant min**, par axe
 * (max_x, min_x, max_y, min_y, max_z, min_z). Les lire dans l'ordre intuitif
 * ne lève aucune erreur : on obtient une emprise négative parfaitement
 * plausible (« -1000 × -1000 m ») qui se propage ensuite dans tout calcul
 * d'échelle ou de recentrage.
 */
export function parseCopcHeader(bytes) {
  if (bytes.length < HEADER_PROBE_SIZE) {
    throw new ProtocolError(`en-tête tronqué: ${bytes.length} o (${HEADER_PROBE_SIZE} attendus)`);
  }
  const dv = view(bytes);

  const signature = ascii(bytes, 0, 4);
  if (signature !== 'LASF') {
    throw new ProtocolError(`signature LAS absente (lu "${signature}")`);
  }

  const versionMajor = dv.getUint8(24);
  const versionMinor = dv.getUint8(25);
  if (versionMajor !== 1 || versionMinor !== 4) {
    throw new ProtocolError(`LAS ${versionMajor}.${versionMinor} non géré (1.4 attendu)`);
  }

  const headerSize = dv.getUint16(94, true);
  const offsetToPointData = dv.getUint32(96, true);
  const vlrCount = dv.getUint32(100, true);

  // Le bit de poids fort du format signale la compression LAZ ; le format réel
  // tient sur les 6 bits bas (134 = 0x86 -> format 6, compressé).
  const pointFormatRaw = dv.getUint8(104);
  const pointFormat = pointFormatRaw & 0x3f;
  const compressed = (pointFormatRaw & 0x80) !== 0;
  const pointLength = dv.getUint16(105, true);

  const scale = [dv.getFloat64(131, true), dv.getFloat64(139, true), dv.getFloat64(147, true)];
  const offset = [dv.getFloat64(155, true), dv.getFloat64(163, true), dv.getFloat64(171, true)];

  const maxX = dv.getFloat64(179, true);
  const minX = dv.getFloat64(187, true);
  const maxY = dv.getFloat64(195, true);
  const minY = dv.getFloat64(203, true);
  const maxZ = dv.getFloat64(211, true);
  const minZ = dv.getFloat64(219, true);

  const pointCount = Number(dv.getBigUint64(247, true));

  // La spec COPC impose que la VLR `copc info` soit la toute première,
  // donc à un décalage fixe juste après l'en-tête LAS.
  const vlrUserId = ascii(bytes, LAS_HEADER_SIZE + 2, 16);
  const vlrRecordId = dv.getUint16(LAS_HEADER_SIZE + 18, true);
  if (vlrUserId !== 'copc' || vlrRecordId !== 1) {
    throw new ProtocolError(
      `ce fichier n'est pas un COPC (VLR #1 = "${vlrUserId}"/${vlrRecordId}, "copc"/1 attendu)`,
    );
  }

  const d = LAS_HEADER_SIZE + VLR_HEADER_SIZE;
  const info = {
    center: [dv.getFloat64(d, true), dv.getFloat64(d + 8, true), dv.getFloat64(d + 16, true)],
    halfSize: dv.getFloat64(d + 24, true),
    spacing: dv.getFloat64(d + 32, true),
    rootHierOffset: Number(dv.getBigUint64(d + 40, true)),
    rootHierSize: Number(dv.getBigInt64(d + 48, true)),
    gpsTimeMin: dv.getFloat64(d + 56, true),
    gpsTimeMax: dv.getFloat64(d + 64, true),
  };

  if (!(info.rootHierSize > 0)) {
    throw new ProtocolError(`page de hiérarchie racine vide (taille ${info.rootHierSize})`);
  }

  return {
    versionMajor,
    versionMinor,
    headerSize,
    offsetToPointData,
    vlrCount,
    pointFormat,
    pointFormatRaw,
    compressed,
    pointLength,
    scale,
    offset,
    pointCount,
    bounds: { minX, minY, minZ, maxX, maxY, maxZ },
    ...info,
  };
}

/** Densité moyenne au sol, en points par m². */
export function averageDensity(header) {
  const { minX, minY, maxX, maxY } = header.bounds;
  const area = (maxX - minX) * (maxY - minY);
  return area > 0 ? header.pointCount / area : NaN;
}
