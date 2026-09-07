import { ProtocolError } from '../net/errors.js';

export const ENTRY_SIZE = 32;

/**
 * Décode une page de hiérarchie COPC.
 *
 * Chaque entrée de 32 octets décrit soit un nœud de points, soit un renvoi vers
 * une sous-page. Le discriminant est `pointCount` : la valeur **-1** ne veut pas
 * dire « nœud vide » mais « ce n'est pas un nœud, c'est une page à charger ».
 * Les confondre revient à lire des octets de hiérarchie comme des points
 * compressés, ce qui produit du déchet plutôt qu'une erreur.
 */
export function parseHierarchyPage(bytes) {
  if (bytes.length === 0 || bytes.length % ENTRY_SIZE !== 0) {
    throw new ProtocolError(
      `page de hiérarchie malformée: ${bytes.length} o (multiple de ${ENTRY_SIZE} attendu)`,
    );
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nodes = [];
  const childPages = [];

  for (let i = 0; i < bytes.length; i += ENTRY_SIZE) {
    const key = {
      level: dv.getInt32(i, true),
      x: dv.getInt32(i + 4, true),
      y: dv.getInt32(i + 8, true),
      z: dv.getInt32(i + 12, true),
    };
    const offset = Number(dv.getBigUint64(i + 16, true));
    const byteSize = dv.getInt32(i + 24, true);
    const pointCount = dv.getInt32(i + 28, true);

    if (pointCount === -1) {
      childPages.push({ key, offset, byteSize });
    } else if (pointCount > 0) {
      nodes.push({ key, offset, byteSize, pointCount, id: nodeId(key) });
    }
    // pointCount === 0 : nœud existant mais vide, rien à charger.
  }

  return { nodes, childPages };
}

export function nodeId(key) {
  return `${key.level}-${key.x}-${key.y}-${key.z}`;
}

/**
 * Charge la hiérarchie en suivant les sous-pages, mais seulement celles qui
 * peuvent contenir des nœuds au niveau demandé : inutile de descendre l'octree
 * entier pour n'afficher que les trois premiers niveaux.
 */
export async function loadHierarchy(header, readPage, { maxLevel = Infinity } = {}) {
  const nodes = [];
  let pagesRead = 0;
  const queue = [{ key: { level: 0, x: 0, y: 0, z: 0 }, offset: header.rootHierOffset, byteSize: header.rootHierSize }];

  while (queue.length > 0) {
    const page = queue.shift();
    const bytes = await readPage(page.offset, page.byteSize);
    pagesRead += 1;
    const { nodes: pageNodes, childPages } = parseHierarchyPage(bytes);

    for (const node of pageNodes) {
      if (node.key.level <= maxLevel) nodes.push(node);
    }
    for (const child of childPages) {
      if (child.key.level <= maxLevel) queue.push(child);
    }
  }

  nodes.sort((a, b) => a.key.level - b.key.level);
  return { nodes, pagesRead };
}

/** Récapitulatif par niveau — sert à savoir ce qu'un chargement va coûter. */
export function summarise(nodes) {
  const byLevel = new Map();
  for (const n of nodes) {
    const acc = byLevel.get(n.key.level) ?? { level: n.key.level, nodes: 0, points: 0, bytes: 0 };
    acc.nodes += 1;
    acc.points += n.pointCount;
    acc.bytes += n.byteSize;
    byLevel.set(n.key.level, acc);
  }
  return [...byLevel.values()].sort((a, b) => a.level - b.level);
}
