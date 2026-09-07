import { describe, expect, it } from 'vitest';
import { isWithinMetropole, tileNameAt, toLambert93, toWgs84 } from '../src/geo/projection.js';
import { TileIndex, acquisitionSeason, contains, parseTileFeature } from '../src/geo/wfs.js';
import { NetworkError, ProtocolError } from '../src/net/errors.js';

describe('projection Lambert-93', () => {
  it("place l'origine de la projection à son point de définition", () => {
    // lon 3°, lat 46,5° est le centre du Lambert-93 : il tombe exactement sur
    // (700 000, 6 600 000) par construction. Un point de référence qui ne dépend
    // d'aucune mesure extérieure.
    const [x, y] = toLambert93(3, 46.5);
    expect(x).toBeCloseTo(700_000, 3);
    expect(y).toBeCloseTo(6_600_000, 3);
  });

  it('boucle sans dérive sur plusieurs villes', () => {
    for (const [lon, lat] of [
      [1.4442, 43.6045], // Toulouse
      [2.3522, 48.8566], // Paris
      [-4.4861, 48.3904], // Brest
      [7.752, 48.5734], // Strasbourg
      [9.15, 41.9], // Corse
    ]) {
      const [x, y] = toLambert93(lon, lat);
      const [lon2, lat2] = toWgs84(x, y);
      expect(lon2).toBeCloseTo(lon, 9);
      expect(lat2).toBeCloseTo(lat, 9);
    }
  });

  it('situe Toulouse dans la bonne dalle kilométrique', () => {
    const [x, y] = toLambert93(1.4442, 43.6045);
    expect(x).toBeGreaterThan(570_000);
    expect(x).toBeLessThan(580_000);
    expect(isWithinMetropole(x, y)).toBe(true);
  });

  it('écarte ce qui est hors métropole', () => {
    const [gx, gy] = toLambert93(-52.33, 4.92); // Cayenne
    expect(isWithinMetropole(gx, gy)).toBe(false);
  });

  it('nomme la dalle par son coin nord-ouest', () => {
    // La dalle LHD_FXX_0573_6278 couvre X 573000-574000 et Y 6277000-6278000 :
    // l'abscisse est arrondie vers le bas, l'ordonnée vers le haut.
    expect(tileNameAt(573_500, 6_277_500)).toBe('0573_6278');
    expect(tileNameAt(573_000, 6_277_001)).toBe('0573_6278');
  });
});

/** Entité capturée sur le service réel, réduite à ce que le code lit. */
const REAL_FEATURE = {
  type: 'Feature',
  id: 'dalle.356932',
  geometry: {
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [573000.00009439, 6278000.00474024],
          [574000.00009365, 6278000.00474025],
          [574000.00009363, 6277000.00474007],
          [573000.00009438, 6277000.00474004],
          [573000.00009439, 6278000.00474024],
        ],
      ],
    ],
  },
  properties: {
    id: '67517',
    name: 'LHD_FXX_0573_6278_PTS_C_LAMB93_IGN69',
    url: 'https://data.geopf.fr/telechargement/download/LiDARHD-NUALID/NUALHD_1-0__LAZ_LAMB93_IQ_2024-12-20/LHD_FXX_0573_6278_PTS_LAMB93_IGN69.copc.laz',
    format: 'copc',
    metadata:
      '{"capteur": ["RIEGL VQ-1560 II:S2224049"], "code_mission": "22LHD1IQ", "date_edition": "2024-12-20", "nombre_points": 31417300, "moe_acquisition": "Eurosense", "procede_classement": "IGN_AUTO_V5", "date_fin_acquisition": "2022-06-15", "systeme_altimetrique": "IGN69", "date_debut_acquisition": "2022-05-29"}',
  },
};

function fakeFetch(payload, { status = 200 } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  });
}

describe('parseTileFeature', () => {
  it('extrait emprise, URL et acquisition', () => {
    const tile = parseTileFeature(REAL_FEATURE);
    expect(tile.bounds).toEqual({
      minX: 573000.00009438,
      minY: 6277000.00474004,
      maxX: 574000.00009365,
      maxY: 6278000.00474025,
    });
    expect(tile.acquisition.start).toBe('2022-05-29');
    expect(tile.acquisition.sensor).toBe('RIEGL VQ-1560 II:S2224049');
    expect(tile.acquisition.classifier).toBe('IGN_AUTO_V5');
    expect(tile.announcedPointCount).toBe(31_417_300);
  });

  it("n'invente jamais l'URL à partir du nom", () => {
    // Le nom porte « _PTS_C_ » là où l'URL porte « _PTS_ » : reconstruire l'un
    // depuis l'autre donnerait une adresse en 404.
    const tile = parseTileFeature(REAL_FEATURE);
    expect(tile.name).toContain('_PTS_C_');
    expect(tile.url).toContain('_PTS_LAMB93');
    expect(tile.url).toBe(REAL_FEATURE.properties.url);
  });

  it('reste utilisable quand la métadonnée manque ou est illisible', () => {
    for (const metadata of [undefined, '', '{ceci n est pas du JSON', null]) {
      const tile = parseTileFeature({
        ...REAL_FEATURE,
        properties: { ...REAL_FEATURE.properties, metadata },
      });
      expect(tile).not.toBeNull();
      expect(tile.url).toBe(REAL_FEATURE.properties.url);
      expect(tile.acquisition.start).toBeNull();
      expect(tile.announcedPointCount).toBeNull();
    }
  });

  it('rejette une entité sans URL ou sans géométrie', () => {
    expect(parseTileFeature({ properties: {} })).toBeNull();
    expect(parseTileFeature({ properties: { url: 'x' }, geometry: null })).toBeNull();
  });
});

describe('TileIndex', () => {
  it('rend null sur une zone non couverte, sans lever d erreur', async () => {
    // Le cas qui arrivera le plus souvent au début : le serveur répond 200 avec
    // une liste vide. Le traiter comme une panne afficherait une erreur alarmante
    // là où il n'y a qu'une absence de données.
    const index = new TileIndex({
      fetchImpl: fakeFetch({ type: 'FeatureCollection', features: [], numberMatched: 0 }),
    });
    await expect(index.findAt(0, 6_500_000)).resolves.toBeNull();
  });

  it('choisit la dalle qui contient réellement le point', async () => {
    const other = structuredClone(REAL_FEATURE);
    other.properties.url = 'https://exemple/voisine.copc.laz';
    other.geometry.coordinates = [
      [
        [
          [574000, 6278000],
          [575000, 6278000],
          [575000, 6277000],
          [574000, 6277000],
          [574000, 6278000],
        ],
      ],
    ];
    // La voisine est renvoyée en premier : prendre « la première » serait faux.
    const index = new TileIndex({
      fetchImpl: fakeFetch({ features: [other, REAL_FEATURE], numberMatched: 2 }),
    });
    const tile = await index.findAt(573_500, 6_277_500);
    expect(tile.url).toBe(REAL_FEATURE.properties.url);
  });

  it('lit numberMatched pour compter sans tout rapatrier', async () => {
    const index = new TileIndex({
      fetchImpl: fakeFetch({ features: [REAL_FEATURE], numberMatched: 144 }),
    });
    await expect(index.count({ minX: 0, minY: 0, maxX: 1, maxY: 1 })).resolves.toBe(144);
  });

  it('signale la troncature quand la vue dépasse la limite', async () => {
    const index = new TileIndex({
      fetchImpl: fakeFetch({ features: [REAL_FEATURE], numberMatched: 144 }),
    });
    const r = await index.findIn({ minX: 0, minY: 0, maxX: 1, maxY: 1 }, { limit: 10 });
    expect(r.truncated).toBe(true);
    expect(r.matched).toBe(144);
  });

  it('distingue une panne réseau d une absence de données', async () => {
    const down = new TileIndex({
      fetchImpl: async () => {
        throw new Error('connexion refusée');
      },
    });
    await expect(down.findAt(573_500, 6_277_500)).rejects.toBeInstanceOf(NetworkError);

    const broken = new TileIndex({ fetchImpl: fakeFetch({ pas: 'de features' }) });
    await expect(broken.findAt(573_500, 6_277_500)).rejects.toBeInstanceOf(ProtocolError);

    const http500 = new TileIndex({ fetchImpl: fakeFetch({}, { status: 500 }) });
    await expect(http500.findAt(573_500, 6_277_500)).rejects.toThrow(/HTTP 500/);
  });
});

describe('contains et saison', () => {
  it('teste l appartenance à une emprise', () => {
    const b = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    expect(contains(b, 5, 5)).toBe(true);
    expect(contains(b, 11, 5)).toBe(false);
  });

  it('qualifie la saison du relevé', () => {
    expect(acquisitionSeason({ start: '2022-05-29' })).toBe('végétation en feuilles');
    expect(acquisitionSeason({ start: '2022-01-14' })).toBe('végétation sans feuilles');
    expect(acquisitionSeason({ start: '2022-04-02' })).toBe('végétation intermédiaire');
    expect(acquisitionSeason({})).toBeNull();
  });
});
