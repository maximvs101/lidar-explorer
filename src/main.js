import { TileLoader } from './loader.js';
import { RequestQueue } from './net/queue.js';
import { DecoderPool } from './decode/decoder.js';

/** Dalle de référence : Toulouse, île du Ramier (LHD_FXX_0573_6278). */
const TILE_URL =
  'https://data.geopf.fr/telechargement/download/LiDARHD-NUALID/' +
  'NUALHD_1-0__LAZ_LAMB93_IQ_2024-12-20/LHD_FXX_0573_6278_PTS_LAMB93_IGN69.copc.laz';

const MAX_LEVEL = 2;
const CONCURRENCY = 4;

const el = {
  load: document.getElementById('load'),
  reload: document.getElementById('reload'),
  clear: document.getElementById('clear'),
  log: document.getElementById('log'),
  checks: document.getElementById('checks'),
  stats: document.getElementById('stats'),
  canvas: document.getElementById('preview'),
};

const CLASS_COLORS = {
  1: [110, 110, 115], 2: [150, 140, 120], 3: [120, 160, 90], 4: [95, 145, 70],
  5: [60, 120, 55], 6: [205, 120, 95], 9: [70, 120, 180], 17: [170, 170, 180],
  64: [200, 190, 110], 66: [70, 120, 180],
};

function log(message, kind = '') {
  const div = document.createElement('div');
  div.className = kind;
  div.textContent = message;
  el.log.appendChild(div);
  console.log(message);
}

function renderTable(target, rows) {
  target.innerHTML =
    '<table>' +
    rows
      .map(([k, v, kind = '']) => `<tr><td class="k">${k}</td><td class="v ${kind}">${v}</td></tr>`)
      .join('') +
    '</table>';
}

function renderChecks(checks) {
  el.checks.innerHTML = checks
    .map(
      (c) =>
        `<div class="check"><span class="mark ${c.pass ? 'ok' : 'err'}">${c.pass ? '✓' : '✗'}</span>` +
        `<span>${c.label}<br><span style="color:var(--dim)">${c.detail}</span></span></div>`,
    )
    .join('');
}

const fmt = (n) => n.toLocaleString('fr-FR');
const mo = (n) => `${(n / 1e6).toFixed(2)} Mo`;

/**
 * Aperçu du dessus. Ce n'est pas le rendu du projet (lot 3) : c'est un contrôle
 * de justesse. Des points mal décodés produiraient du bruit uniforme, et non une
 * ville — un compteur ne le dirait pas, une image si.
 */
function drawPreview(chunks, bounds, origin) {
  const ctx = el.canvas.getContext('2d');
  const { width: W, height: H } = el.canvas;
  ctx.fillStyle = '#080a0e';
  ctx.fillRect(0, 0, W, H);
  if (chunks.length === 0) return;

  const minX = bounds.minX - origin[0];
  const minY = bounds.minY - origin[1];
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  const scale = (Math.min(W, H) - 8) / span;
  const image = ctx.createImageData(W, H);
  const data = image.data;
  const zBuffer = new Float32Array(W * H).fill(-Infinity);

  for (const { positions, classification } of chunks) {
    for (let i = 0; i < classification.length; i += 1) {
      const px = 4 + ((positions[i * 3] - minX) * scale) | 0;
      const py = H - 4 - (((positions[i * 3 + 1] - minY) * scale) | 0);
      if (px < 0 || px >= W || py < 0 || py >= H) continue;
      const z = positions[i * 3 + 2];
      const idx = py * W + px;
      if (z <= zBuffer[idx]) continue; // on garde le point le plus haut
      zBuffer[idx] = z;
      const [r, g, b] = CLASS_COLORS[classification[i]] ?? [90, 90, 95];
      const o = idx * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
}

let loader = null;

async function makeLoader() {
  loader?.dispose();
  loader = await TileLoader.create({
    queue: new RequestQueue({ concurrency: CONCURRENCY }),
    decoder: new DecoderPool(1),
  });
  return loader;
}

async function run({ expectCacheOnly = false } = {}) {
  el.load.disabled = true;
  el.reload.disabled = true;
  el.log.innerHTML = '';

  const started = performance.now();
  await makeLoader();

  log(`ouverture de la dalle…`);
  const tile = await loader.open(TILE_URL);
  const { header } = tile;
  log(
    `LAS ${header.versionMajor}.${header.versionMinor} · format ${header.pointFormat} · ` +
      `${fmt(header.pointCount)} points · ${tile.density.toFixed(1)} pts/m²`,
    'ok',
  );

  const { nodes, pagesRead, levels } = await loader.hierarchy(tile, { maxLevel: MAX_LEVEL });
  const expectedPoints = nodes.reduce((a, n) => a + n.pointCount, 0);
  log(`hiérarchie : ${pagesRead} page(s), ${nodes.length} nœuds, ${fmt(expectedPoints)} points attendus`);

  const chunks = [];
  let decodedPoints = 0;
  let peakInFlight = 0;
  const poll = setInterval(() => {
    peakInFlight = Math.max(peakInFlight, loader.queue.inFlight);
  }, 4);

  await loader.loadNodes(tile, nodes, {
    onNode: ({ positions, classification }) => {
      chunks.push({ positions, classification });
      decodedPoints += classification.length;
    },
  });
  clearInterval(poll);

  const elapsed = performance.now() - started;
  const report = loader.report();

  drawPreview(chunks, header.bounds, tile.origin);

  // --- contrôles ---
  const checks = [
    {
      label: 'Tous les points annoncés ont été décodés',
      pass: decodedPoints === expectedPoints,
      detail: `${fmt(decodedPoints)} décodés / ${fmt(expectedPoints)} annoncés par la hiérarchie`,
    },
    {
      label: 'Le plafond de concurrence a tenu',
      pass: report.queue.maxInFlight <= CONCURRENCY,
      detail: `maximum ${report.queue.maxInFlight} requêtes simultanées (plafond ${CONCURRENCY})`,
    },
    {
      label: 'Aucun quota dépassé',
      pass: report.queue.rateLimited === 0,
      detail:
        report.queue.rateLimited === 0
          ? 'aucun HTTP 429'
          : `${report.queue.rateLimited} refus 429, ${report.queue.retries} reprises`,
    },
  ];

  if (expectCacheOnly) {
    checks.push({
      label: 'Second chargement servi entièrement par le cache',
      pass: report.networkRequests === 0,
      detail:
        report.networkRequests === 0
          ? `0 requête réseau, ${report.cacheHits} lectures en cache (${mo(report.cacheBytes)})`
          : `${report.networkRequests} requêtes réseau — le cache n'a pas couvert tout le chargement`,
    });
  } else {
    checks.push({
      label: 'Le cache persistant est disponible',
      pass: report.cacheAvailable,
      detail: report.cacheAvailable
        ? `${report.cacheHits} lectures en cache, ${report.cacheMisses} manques`
        : 'indisponible — le chargement fonctionne, mais tout repassera par le réseau',
    });
  }

  renderChecks(checks);
  renderTable(el.stats, [
    ['durée totale', `${(elapsed / 1000).toFixed(1)} s`],
    ['requêtes réseau', fmt(report.networkRequests)],
    ['octets réseau', mo(report.networkBytes)],
    ['lectures en cache', fmt(report.cacheHits)],
    ['octets depuis le cache', mo(report.cacheBytes)],
    ['max requêtes simultanées', `${report.queue.maxInFlight} / ${CONCURRENCY}`],
    ['reprises (429 ou réseau)', fmt(report.queue.retries)],
    ['nœuds décodés', fmt(report.decode.decoded)],
    ['points décodés', fmt(report.decode.points)],
    ['temps de décodage', `${(report.decode.ms / 1000).toFixed(2)} s`],
    [
      'débit de décodage',
      `${(report.decode.points / (report.decode.ms / 1000) / 1e6).toFixed(2)} M pts/s`,
    ],
    ['heap WASM ré-attaché', fmt(report.decode.heapRebinds)],
    ...levels.map((l) => [
      `  niveau ${l.level}`,
      `${l.nodes} nœuds · ${fmt(l.points)} pts · ${mo(l.bytes)}`,
    ]),
  ]);

  const allPass = checks.every((c) => c.pass);
  log(allPass ? 'tous les contrôles passent' : 'un contrôle a échoué', allPass ? 'ok' : 'err');

  el.load.disabled = false;
  el.reload.disabled = false;

  window.__lot1 = {
    checks: checks.map(({ label, pass, detail }) => ({ label, pass, detail })),
    allPass,
    report,
    decodedPoints,
    expectedPoints,
    elapsed,
    peakInFlight,
  };
  return window.__lot1;
}

el.load.addEventListener('click', () => run().catch((e) => log(`échec : ${e.message}`, 'err')));
el.reload.addEventListener('click', () =>
  run({ expectCacheOnly: true }).catch((e) => log(`échec : ${e.message}`, 'err')),
);
el.clear.addEventListener('click', async () => {
  await (await makeLoader()).cache?.clear();
  log('cache vidé', 'warn');
  el.reload.disabled = true;
});

window.__run = run;
log('prêt. « Charger » lit la dalle depuis le réseau ; « Recharger » doit la servir du cache.');
