import { describe, expect, it } from 'vitest';
import { NODATA, PRODUITS, RasterGrid, decodeBil, fetchRaster, rasterUrl } from '../src/analysis/rasters.js';
import { TerrainGrid } from '../src/analysis/terrain.js';

/**
 * Fabrique un flux BIL à partir des lignes telles que le serveur les envoie :
 * `lignes[0]` est la ligne du NORD, comme dans n'importe quelle image.
 */
function bil(lignes) {
  const n = lignes.length;
  const buffer = new ArrayBuffer(n * n * 4);
  const vue = new DataView(buffer);
  for (let l = 0; l < n; l += 1) {
    for (let i = 0; i < n; i += 1) vue.setFloat32((l * n + i) * 4, lignes[l][i], true);
  }
  return buffer;
}

function reponse(buffer, { ok = true, status = 200 } = {}) {
  return { ok, status, arrayBuffer: async () => buffer };
}

describe('URL du service', () => {
  it('demande bien du float32 brut, en Lambert-93', () => {
    const u = new URL(rasterUrl({ bbox: [843000, 6455000, 846000, 6458000], pixels: 1024 }));
    expect(u.searchParams.get('FORMAT')).toBe('image/x-bil;bits=32');
    expect(u.searchParams.get('CRS')).toBe('EPSG:2154');
    expect(u.searchParams.get('BBOX')).toBe('843000,6455000,846000,6458000');
    expect(u.searchParams.get('WIDTH')).toBe('1024');
    expect(u.searchParams.get('HEIGHT')).toBe('1024');
    expect(u.searchParams.get('LAYERS')).toMatch(/MNT/);
  });

  it('vise la bonne couche selon le produit', () => {
    const couche = (produit) => new URL(rasterUrl({ bbox: [0, 0, 1, 1], pixels: 4, produit }))
      .searchParams.get('LAYERS');
    expect(couche('mnt')).toMatch(/_MNT_/);
    expect(couche('mns')).toMatch(/_MNS_/);
    expect(couche('mnh')).toMatch(/_MNH_/);
    // Trois couches distinctes : une faute de frappe qui en collerait deux
    // rendrait des hauteurs plausibles et fausses.
    expect(new Set(['mnt', 'mns', 'mnh'].map(couche)).size).toBe(3);
    expect(() => rasterUrl({ bbox: [0, 0, 1, 1], pixels: 4, produit: 'mno' })).toThrow(/inconnu/);
  });

  it('refuse une taille que le service rejetterait', () => {
    expect(() => rasterUrl({ bbox: [0, 0, 1, 1], pixels: 6000 })).toThrow(/5010/);
    expect(() => rasterUrl({ bbox: [0, 0, 1, 1], pixels: 1 })).toThrow();
    expect(() => rasterUrl({ bbox: [0, 0, 1, 1], pixels: 512.5 })).toThrow(/entier/);
  });
});

describe('décodage BIL', () => {
  it('lit les octets en little-endian', () => {
    // 1.0f en little-endian s'écrit 00 00 80 3F ; lu à l'envers, il ne vaut
    // pas 1 mais 4.6e-41. Un test qui se contenterait de comparer deux
    // décodages entre eux ne verrait rien.
    const buffer = new Uint8Array([0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x00, 0x42,
                                   0x00, 0x00, 0x20, 0x41, 0x00, 0x00, 0x48, 0x42]).buffer;
    const { height } = decodeBil(buffer, 2);
    // Ligne 0 (nord) -> j=1 ; ligne 1 (sud) -> j=0.
    expect([...height]).toEqual([10, 50, 1, 32]);
  });

  it('retourne les lignes : la première du flux est au NORD', () => {
    // Le piège : la ligne 0 d'une image est en haut, tandis que la grille
    // indexe ses lignes du sud vers le nord. Sans retournement, le terrain est
    // juste sur l'axe médian et faux partout ailleurs — invisible sur du plat.
    const buffer = bil([
      [100, 101], // nord
      [200, 201], // sud
    ]);
    const g = new RasterGrid({ center: [0, 0], size: 200, cells: 2, ...decodeBil(buffer, 2) });
    expect(g.heightAt(-50, +50)).toBe(100); // nord-ouest
    expect(g.heightAt(+50, +50)).toBe(101); // nord-est
    expect(g.heightAt(-50, -50)).toBe(200); // sud-ouest
    expect(g.heightAt(+50, -50)).toBe(201); // sud-est
  });

  it('traite -9999 comme une absence, pas comme une altitude', () => {
    const buffer = bil([[NODATA, 120], [130, 140]]);
    const { known, observed } = decodeBil(buffer, 2);
    expect(observed).toBe(3);
    const g = new RasterGrid({ center: [0, 0], size: 200, cells: 2, ...decodeBil(buffer, 2) });
    expect(Number.isNaN(g.heightAt(-50, 50))).toBe(true);
    expect(Number.isNaN(g.aboveGround(-50, 50, 300))).toBe(true);
    expect(g.aboveGround(50, 50, 140)).toBeCloseTo(20);
    expect(known.reduce((a, b) => a + b, 0)).toBe(3);
    expect(g.coverage()).toBeCloseTo(0.75);
  });

  it('refuse un flux de la mauvaise taille plutôt que de lire au hasard', () => {
    expect(() => decodeBil(new ArrayBuffer(12), 2)).toThrow(/16 attendus/);
  });
});

describe('RasterGrid', () => {
  it('est utilisable sans construction : le raster arrive complet', () => {
    const g = new RasterGrid({ center: [0, 0], size: 100, cells: 2, ...decodeBil(bil([[5, 5], [5, 5]]), 2) });
    expect(g.filled).toBe(true);
    expect(g.source).toBe('mnt');
    expect(g.step).toBe(50);
  });

  it('offre la même lecture que la grille calculée', () => {
    // C'est ce qui permet de substituer l'une à l'autre : le rendu, l'audit et
    // la canopée ne doivent pas avoir à savoir laquelle répond.
    const calcule = new TerrainGrid({ center: [0, 0], size: 100, cells: 2 });
    for (const nom of ['heightAt', 'aboveGround', 'coverage', 'coverageWithin', 'index']) {
      expect(typeof Object.getPrototypeOf(calcule)[nom] ?? null).toBeDefined();
    }
    const officiel = new RasterGrid({ center: [0, 0], size: 100, cells: 2, ...decodeBil(bil([[5, 5], [5, 5]]), 2) });
    for (const nom of ['heightAt', 'aboveGround', 'coverage', 'coverageWithin', 'index']) {
      expect(typeof officiel[nom]).toBe('function');
    }
  });
});

describe('couverture : mesurée ou estimée', () => {
  it('ne compte pas comme observée une cellule comblée par diffusion', () => {
    // Sans cette distinction, la grille calculée annoncerait 100 % de
    // couverture précisément là où elle a tout inventé.
    const g = new TerrainGrid({ center: [0, 0], size: 100, cells: 10 });
    g.addPoints(new Float32Array([-45, -45, 100]), new Uint8Array([2]));
    g.build();
    expect(g.coverage()).toBeCloseTo(0.01, 6);
    expect(g.known.reduce((a, b) => a + b, 0)).toBeGreaterThan(1); // comblé
  });
});

describe('récupération', () => {
  const plat = (n, z) => bil(Array.from({ length: n }, () => Array.from({ length: n }, () => z)));

  it('décale la fenêtre par l’origine de scène', async () => {
    let vue = null;
    const g = await fetchRaster({
      center: [0, 0],
      size: 3000,
      cells: 4,
      origin: [843500, 6455500, 200],
      fetchImpl: async (url) => { vue = url; return reponse(plat(4, 150)); },
    });
    expect(new URL(vue).searchParams.get('BBOX')).toBe('842000,6454000,845000,6457000');
    // La grille reste en repère de scène, elle : c'est là que vivent les points.
    expect(g.minX).toBe(-1500);
    // Et en altitude aussi : 150 m NGF sous une dalle d'origine 200 m font −50.
    expect(g.heightAt(0, 0)).toBe(-50);
  });

  it('ramène les altitudes dans le repère de scène', async () => {
    // La couture qui coûte le plus cher : le raster est en NGF absolu, les
    // points ont perdu l'origine de leur dalle avant d'être mis en Float32.
    // Sans cette translation, l'écart mesuré sur Toulouse était de −632,36 m,
    // très exactement l'origine de la dalle. Rien ne plante : les hauteurs de
    // canopée sortent simplement toutes négatives.
    const g = await fetchRaster({
      size: 200, cells: 2, origin: [843500, 6455500, 632.33],
      fetchImpl: async () => reponse(bil([[700, 700], [700, 700]])),
    });
    expect(g.heightAt(0, 0)).toBeCloseTo(67.67, 3);
    // Un point à 710 m NGF, soit 77,67 en scène, est bien à 10 m du sol.
    expect(g.aboveGround(0, 0, 710 - 632.33)).toBeCloseTo(10, 3);
  });

  it('ne translate PAS le MNH, qui est déjà une hauteur', async () => {
    // Le MNT et le MNS portent des altitudes NGF, que la scène ramène dans son
    // repère ; le MNH porte une hauteur au-dessus du sol. Lui appliquer la même
    // translation donnerait des arbres à −600 m — sans la moindre erreur.
    const commun = {
      size: 200, cells: 2, origin: [843500, 6455500, 632.33],
      fetchImpl: async () => reponse(bil([[700, 700], [700, 700]])),
    };
    const sol = await fetchRaster({ ...commun, produit: 'mnt' });
    const haut = await fetchRaster({ ...commun, produit: 'mnh' });
    expect(sol.heightAt(0, 0)).toBeCloseTo(67.67, 3);
    expect(haut.heightAt(0, 0)).toBe(700);
    expect(haut.zOffset).toBe(0);
    expect(PRODUITS.mnh.altitude).toBe(false);
  });

  it('ne translate pas la sentinelle d’absence', async () => {
    // Décalée, −9999 deviendrait une altitude comme une autre : le rendu la
    // reconnaît à sa valeur, et peindrait du terrain là où il n'y en a pas.
    const g = await fetchRaster({
      size: 200, cells: 2, minCoverage: 0.2, origin: [0, 0, 500],
      fetchImpl: async () => reponse(bil([[NODATA, NODATA], [NODATA, 700]])),
    });
    expect(g.heightAt(50, -50)).toBeCloseTo(200);
    expect(Number.isNaN(g.heightAt(-50, 50))).toBe(true);
    expect(g.height[g.index(-50, 50)]).toBe(NODATA);
  });

  it('suit un centre décalé dans la scène', async () => {
    let vue = null;
    await fetchRaster({
      center: [500, -500],
      size: 1000,
      cells: 4,
      origin: [843500, 6455500, 200],
      fetchImpl: async (url) => { vue = url; return reponse(plat(4, 150)); },
    });
    expect(new URL(vue).searchParams.get('BBOX')).toBe('843500,6454500,844500,6455500');
  });

  it('rend null hors couverture plutôt qu’un terrain vide', async () => {
    // En mer, le service répond 200 avec -9999 partout. Le prendre pour un
    // terrain donnerait des hauteurs nulles au lieu d'aucune hauteur.
    const g = await fetchRaster({
      size: 3000, cells: 4, origin: [0, 0, 0],
      fetchImpl: async () => reponse(plat(4, NODATA)),
    });
    expect(g).toBe(null);
  });

  it('accepte une couverture partielle au-dessus du seuil', async () => {
    const moitie = bil([[NODATA, NODATA], [120, 121]]);
    const g = await fetchRaster({
      size: 200, cells: 2, minCoverage: 0.5, origin: [0, 0, 0],
      fetchImpl: async () => reponse(moitie),
    });
    expect(g).not.toBe(null);
    expect(g.coverage()).toBeCloseTo(0.5);
  });

  it('signale une réponse d’erreur WMS au lieu de la décoder', async () => {
    // Le service rend ses erreurs en XML avec un code 200 : sans ce contrôle,
    // le message d'erreur serait lu comme des altitudes.
    const xml = new TextEncoder().encode(
      '<?xml version="1.0"?><ServiceExceptionReport><ServiceException code="InvalidCRS"/>',
    ).buffer;
    await expect(fetchRaster({
      size: 3000, cells: 4, origin: [0, 0, 0],
      fetchImpl: async () => reponse(xml),
    })).rejects.toThrow(/InvalidCRS/);
  });

  it('remonte un échec HTTP', async () => {
    await expect(fetchRaster({
      size: 3000, cells: 4, origin: [0, 0, 0],
      fetchImpl: async () => reponse(new ArrayBuffer(64), { ok: false, status: 503 }),
    })).rejects.toThrow(/503/);
  });
});

describe('distribution sur une emprise', () => {
  // Ce que le raster a d'irremplaçable : il décrit toute la zone au même pas,
  // alors que les statistiques tirées des points ne portent que sur ce que
  // l'octree a livré.
  const grille = (lignes) => new RasterGrid({
    center: [0, 0], size: 400, cells: lignes.length, produit: 'mnh',
    ...decodeBil(bil(lignes), lignes.length),
  });

  it('rend médiane, centiles et maximum', () => {
    const g = grille([[0, 10, 20, 30], [0, 10, 20, 40], [0, 10, 20, 30], [0, 10, 20, 30]]);
    const d = g.distribution([0, 0], 1000);
    expect(d.count).toBe(16);
    expect(d.median).toBe(20);
    expect(d.max).toBe(40);
    expect(d.unknown).toBe(0);
  });

  it('se restreint à l’emprise demandée', () => {
    // 4 cellules de 100 m : une fenêtre de 100 m au centre n'en prend pas 16.
    const g = grille([[0, 0, 0, 0], [0, 5, 5, 0], [0, 5, 5, 0], [0, 0, 0, 0]]);
    const large = g.distribution([0, 0], 1000);
    const etroite = g.distribution([0, 0], 100);
    expect(large.total).toBe(16);
    expect(etroite.total).toBeLessThan(large.total);
    expect(etroite.median).toBe(5);
    expect(large.median).toBe(0);
  });

  it('écarte les valeurs sous le seuil sans les compter comme absentes', () => {
    // Pour la canopée : le sol nu (hauteur ~0) n'est pas de la végétation, mais
    // il n'est pas non plus une donnée manquante.
    const g = grille([[0, 0, 18, 22], [0, 0, 18, 22], [0, 0, 18, 22], [0, 0, 18, 22]]);
    const tout = g.distribution([0, 0], 1000);
    const hautes = g.distribution([0, 0], 1000, { minValue: 2 });
    expect(tout.median).toBe(18);
    expect(hautes.count).toBe(8);
    expect(hautes.median).toBe(22);
    expect(hautes.unknown).toBe(0);
  });

  it('compte les cellules absentes plutôt que de les ignorer', () => {
    const g = grille([[NODATA, NODATA], [10, 20]]);
    const d = g.distribution([0, 0], 1000);
    expect(d.total).toBe(4);
    expect(d.count).toBe(2);
    expect(d.unknown).toBe(2);
  });

  it('rend NaN sur une emprise vide plutôt qu’un zéro', () => {
    const g = grille([[NODATA, NODATA], [NODATA, NODATA]]);
    const d = g.distribution([0, 0], 1000);
    expect(d.count).toBe(0);
    expect(Number.isNaN(d.median)).toBe(true);
  });
});

describe('cache', () => {
  it('transmet l’option de cache à fetch', async () => {
    // Le service assortit ses réponses d'erreur d'un max-age de 21 jours : une
    // panne d'une seconde reste figée trois semaines, et redemander la même URL
    // ne fait que relire l'erreur. Une reprise n'a de sens qu'en revalidant.
    const vues = [];
    const plat = bil([[10, 10], [10, 10]]);
    await fetchRaster({
      size: 200, cells: 2, origin: [0, 0, 0],
      fetchImpl: async (url, opts) => { vues.push(opts?.cache); return reponse(plat); },
    });
    await fetchRaster({
      size: 200, cells: 2, origin: [0, 0, 0], cache: 'reload',
      fetchImpl: async (url, opts) => { vues.push(opts?.cache); return reponse(plat); },
    });
    expect(vues).toEqual([undefined, 'reload']);
  });
});
