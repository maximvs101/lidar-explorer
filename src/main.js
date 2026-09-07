import { TileLoader } from './loader.js';
import { RequestQueue } from './net/queue.js';
import { DecoderPool } from './decode/decoder.js';
import { TileIndex, acquisitionSeason } from './geo/wfs.js';
import { isWithinMetropole, tileNameAt } from './geo/projection.js';
import { LocationPicker } from './ui/map.js';

const MAX_LEVEL = 2;
const CONCURRENCY = 4;

const el = {
  load: document.getElementById('load'),
  clear: document.getElementById('clear'),
  log: document.getElementById('log'),
  notice: document.getElementById('notice'),
  tile: document.getElementById('tile'),
  checks: document.getElementById('checks'),
  stats: document.getElementById('stats'),
  canvas: document.getElementById('preview'),
};

const CLASS_COLORS = {
  1: [110, 110, 115], 2: [150, 140, 120], 3: [120, 160, 90], 4: [95, 145, 70],
  5: [60, 120, 55], 6: [205, 120, 95], 9: [70, 120, 180], 17: [170, 170, 180],
  64: [200, 190, 110], 66: [70, 120, 180],
};

const fmt = (n) => n.toLocaleString('fr-FR');
const mo = (n) => `${(n / 1e6).toFixed(2)} Mo`;

function log(message, kind = '') {
  const div = document.createElement('div');
  div.className = kind;
  div.textContent = message;
  el.log.appendChild(div);
}

function clearLog() {
  el.log.innerHTML = '';
}

function notice(html, kind = '') {
  el.notice.className = `show ${kind}`;
  el.notice.innerHTML = html;
}

function hideNotice() {
  el.notice.className = '';
}

function table(target, rows) {
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
        `<span>${c.label}<br><span class="dim">${c.detail}</span></span></div>`,
    )
    .join('');
}

function drawPreview(chunks, bounds, origin) {
  const ctx = el.canvas.getContext('2d');
  const { width: W, height: H } = el.canvas;
  ctx.fillStyle = '#080a0e';
  ctx.fillRect(0, 0, W, H);
  if (!chunks.length) return;

  const minX = bounds.minX - origin[0];
  const minY = bounds.minY - origin[1];
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  const scale = (Math.min(W, H) - 8) / span;
  // `putImageData` écrase la totalité du canvas, fond compris : peindre le fond
  // au préalable avec fillRect ne sert à rien, il faut l'écrire dans le tampon.
  // Sans cela les pixels vides ressortent en noir transparent, et tout contrôle
  // de taux de couverture répond « 100 % ».
  const image = ctx.createImageData(W, H);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 8; data[i + 1] = 10; data[i + 2] = 14; data[i + 3] = 255;
  }
  const zBuffer = new Float32Array(W * H).fill(-Infinity);

  for (const { positions, classification } of chunks) {
    for (let i = 0; i < classification.length; i += 1) {
      const px = (4 + (positions[i * 3] - minX) * scale) | 0;
      const py = (H - 4 - (positions[i * 3 + 1] - minY) * scale) | 0;
      if (px < 0 || px >= W || py < 0 || py >= H) continue;
      const idx = py * W + px;
      const z = positions[i * 3 + 2];
      if (z <= zBuffer[idx]) continue;
      zBuffer[idx] = z;
      const [r, g, b] = CLASS_COLORS[classification[i]] ?? [90, 90, 95];
      const o = idx * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
}

function clearPreview() {
  const ctx = el.canvas.getContext('2d');
  ctx.fillStyle = '#080a0e';
  ctx.fillRect(0, 0, el.canvas.width, el.canvas.height);
}

const index = new TileIndex();
let loader = null;
let selected = null;

async function makeLoader() {
  loader?.dispose();
  loader = await TileLoader.create({
    queue: new RequestQueue({ concurrency: CONCURRENCY }),
    decoder: new DecoderPool(1),
  });
  return loader;
}

function describeTile(tile, point) {
  const a = tile.acquisition;
  const season = acquisitionSeason(a);
  table(el.tile, [
    ['nom', tile.name ?? '—'],
    ['dalle', tileNameAt(point.x, point.y)],
    ['point', `${point.x.toFixed(0)} ; ${point.y.toFixed(0)}`],
    [
      'acquisition',
      a.start && a.end ? `${a.start} → ${a.end}` : (a.start ?? a.end ?? '<span class="warn">non renseignée</span>'),
    ],
    ['saison', season ? `<span class="warn">${season}</span>` : '—'],
    ['capteur', a.sensor ?? '—'],
    ['classement', a.classifier ?? '—'],
    ['altimétrie', a.verticalDatum ?? '—'],
    ['points annoncés', a && tile.announcedPointCount ? fmt(tile.announcedPointCount) : '—'],
  ]);
}

/**
 * Réagit à un clic. Le cas important n'est pas l'erreur mais l'absence : le WFS
 * répond 200 avec une liste vide aussi bien en pleine mer que sur une commune
 * pas encore survolée. On ne peut donc pas annoncer « pas encore livré » — on dit
 * ce qu'on sait, c'est-à-dire qu'aucune dalle n'est publiée ici.
 */
async function pick(point) {
  hideNotice();
  clearLog();
  el.load.disabled = true;
  selected = null;
  el.checks.innerHTML = '<span class="dim">—</span>';
  el.stats.innerHTML = '<span class="dim">—</span>';
  clearPreview();

  if (!isWithinMetropole(point.x, point.y)) {
    picker.select(point, null);
    el.tile.innerHTML = '<span class="dim">hors emprise du Lambert-93</span>';
    notice(
      "<b>Hors de la France métropolitaine.</b><br>Le programme LiDAR HD couvre la métropole, " +
        'la Corse et les DROM sauf la Guyane ; cet explorateur ne gère que la projection Lambert-93.',
      'miss',
    );
    return;
  }

  log('recherche de la dalle…');
  let tile;
  try {
    tile = await index.findAt(point.x, point.y);
  } catch (error) {
    clearLog();
    picker.select(point, null);
    notice(`<b>L'index n'a pas répondu.</b><br>${error.message}`, 'miss');
    return;
  }

  clearLog();
  picker.select(point, tile);

  if (!tile) {
    el.tile.innerHTML = `<span class="dim">dalle ${tileNameAt(point.x, point.y)} — non publiée</span>`;
    notice(
      "<b>Aucune dalle publiée à cet endroit.</b><br>Le service ne distingue pas une zone hors " +
        "territoire d'une zone pas encore livrée : il répond la même chose dans les deux cas. " +
        'Le programme visait une couverture complète fin 2026.',
      'miss',
    );
    return;
  }

  selected = { tile, point };
  describeTile(tile, point);
  el.load.disabled = false;
  log(`dalle trouvée — « Charger le nuage » pour lire les niveaux 0-${MAX_LEVEL}`, 'ok');
}

async function loadSelected() {
  if (!selected) return;
  const { tile: descriptor } = selected;
  el.load.disabled = true;
  clearLog();

  const started = performance.now();
  await makeLoader();

  try {
    log('lecture de l’en-tête…');
    const tile = await loader.open(descriptor.url);
    const { header } = tile;
    log(
      `format ${header.pointFormat} · ${fmt(header.pointCount)} points · ${tile.density.toFixed(1)} pts/m²`,
      'ok',
    );

    const { nodes, levels, pagesRead } = await loader.hierarchy(tile, { maxLevel: MAX_LEVEL });
    const expected = nodes.reduce((a, n) => a + n.pointCount, 0);
    log(`${pagesRead} page(s) de hiérarchie · ${nodes.length} nœuds · ${fmt(expected)} points`);

    const chunks = [];
    let decoded = 0;
    await loader.loadNodes(tile, nodes, {
      onNode: ({ positions, classification }) => {
        chunks.push({ positions, classification });
        decoded += classification.length;
      },
    });

    drawPreview(chunks, header.bounds, tile.origin);
    const report = loader.report();
    const elapsed = performance.now() - started;

    renderChecks([
      {
        label: 'Tous les points annoncés ont été décodés',
        pass: decoded === expected,
        detail: `${fmt(decoded)} / ${fmt(expected)} annoncés par la hiérarchie`,
      },
      {
        label: 'Le plafond de concurrence a tenu',
        pass: report.queue.maxInFlight <= CONCURRENCY,
        detail: `maximum ${report.queue.maxInFlight} requêtes simultanées (plafond ${CONCURRENCY})`,
      },
      {
        label: 'Aucun quota dépassé',
        pass: report.queue.rateLimited === 0,
        detail: report.queue.rateLimited === 0
          ? 'aucun HTTP 429'
          : `${report.queue.rateLimited} refus, ${report.queue.retries} reprises`,
      },
      {
        label: 'Cache persistant disponible',
        pass: report.cacheAvailable,
        detail: `${report.cacheHits} lectures en cache · ${report.cacheMisses} manques`,
      },
    ]);

    table(el.stats, [
      ['durée', `${(elapsed / 1000).toFixed(1)} s`],
      ['requêtes réseau', fmt(report.networkRequests)],
      ['octets réseau', mo(report.networkBytes)],
      ['lectures en cache', `${fmt(report.cacheHits)} (${mo(report.cacheBytes)})`],
      ['max simultanées', `${report.queue.maxInFlight} / ${CONCURRENCY}`],
      ['points décodés', fmt(report.decode.points)],
      ['décodage', `${(report.decode.ms / 1000).toFixed(2)} s`],
      ['débit', `${(report.decode.points / (report.decode.ms / 1000) / 1e6).toFixed(2)} M pts/s`],
      ...levels.map((l) => [`  niveau ${l.level}`, `${fmt(l.points)} pts · ${mo(l.bytes)}`]),
    ]);

    log('chargement terminé', 'ok');
    window.__state = { descriptor, header, decoded, expected, report, elapsed };
  } catch (error) {
    log(`échec : ${error.message}`, 'err');
    notice(`<b>Le chargement a échoué.</b><br>${error.message}`, 'miss');
  } finally {
    el.load.disabled = false;
  }
}

const picker = new LocationPicker(document.getElementById('map'), {
  index,
  onPick: (point) => pick(point).catch((e) => log(`échec : ${e.message}`, 'err')),
  onCoverage: (info) => {
    if (info.error) return log(`couverture indisponible : ${info.error}`, 'warn');
    if (!info.shown) return;
    if (info.truncated) log(`${fmt(info.matched)} dalles dans la vue — ${info.drawn} affichées`, 'dim');
  },
});

el.clear.addEventListener('click', async () => {
  await (await makeLoader()).cache?.clear();
  log('cache vidé', 'warn');
});
el.load.addEventListener('click', () => loadSelected());

clearPreview();
window.__picker = picker;
window.__index = index;
window.__pick = pick;
window.__loadSelected = loadSelected;
log('prêt — cliquez sur la carte.');
