import { TileLoader } from './loader.js';
import { RequestQueue } from './net/queue.js';
import { DecoderPool } from './decode/decoder.js';
import { TileIndex, acquisitionSeason } from './geo/wfs.js';
import { isWithinMetropole, tileNameAt } from './geo/projection.js';
import { LocationPicker } from './ui/map.js';
import { Viewer } from './render/viewer.js';
import { DEFAULT_PALETTE } from './render/pointsMaterial.js';
import { className, shares } from './analysis/classStats.js';
import { cardinal, chooseScale, formatLength, pixelsPerMetre, viewAzimuth } from './ui/scale.js';

const CONCURRENCY = 4;
const POINT_BUDGET = 4_000_000;

const el = {
  load: document.getElementById('load'),
  clear: document.getElementById('clear'),
  log: document.getElementById('log'),
  notice: document.getElementById('notice'),
  tile: document.getElementById('tile'),
  checks: document.getElementById('checks'),
  stats: document.getElementById('stats'),
  hud: document.getElementById('hud'),
  legend: document.getElementById('legend'),
  presets: document.getElementById('presets'),
  biais: document.getElementById('biais'),
  scale: document.getElementById('scale'),
  scalebar: document.getElementById('scalebar'),
  scaletext: document.getElementById('scaletext'),
};

/** Classes masquées, partagées entre la légende et les boutons de préréglage. */
const hidden = new Set();

const PRESETS = {
  tout: [],
  sol: [1, 3, 4, 5, 6, 9, 17, 64, 65, 66, 67],
  bati: [1, 2, 3, 4, 5, 9, 17, 64, 65, 66, 67],
  sansveg: [3, 4, 5],
};

/**
 * Légende des classes présentes dans ce qui est affiché.
 *
 * Les compteurs portent sur les **points affichés**, jamais sur la composition
 * de la zone. Mesuré le 07/09/2026 sur une emprise identique : la part d'une
 * classe dépend fortement du niveau de détail chargé — végétation haute à
 * 24,3 % au niveau 2 contre 16,6 % une fois tous les niveaux réunis, et
 * bâtiment à 47,4 % contre 56,1 %. Présenter ces parts comme la composition du
 * terrain serait faux d'un facteur pouvant atteindre 1,5.
 */
function renderLegend() {
  const counts = viewer.visibleClassCounts();
  if (counts.size === 0) {
    el.legend.innerHTML = '<span class="dim">—</span>';
    el.biais.textContent = '';
    return;
  }
  const rows = shares(counts);
  el.legend.innerHTML = rows
    .map((r) => {
      const rgb = DEFAULT_PALETTE[r.code] ?? [90, 90, 95];
      const off = hidden.has(r.code) ? ' off' : '';
      return (
        `<label class="cls${off}"><input type="checkbox" data-code="${r.code}"` +
        `${hidden.has(r.code) ? '' : ' checked'}>` +
        `<span class="sw" style="background:rgb(${rgb.join(',')})"></span>` +
        `<span class="nm">${r.code} ${className(r.code)}</span>` +
        `<span class="ct">${fmt(r.count)} · ${r.share.toFixed(1)} %</span></label>`
      );
    })
    .join('');
  el.biais.textContent =
    'Parts calculées sur les points actuellement affichés, pas sur la composition ' +
    'du terrain : elles dépendent du niveau de détail chargé (la végétation haute ' +
    'pèse jusqu’à 1,5 fois trop dans une vue d’ensemble).';
}

function applyHidden() {
  viewer.setHiddenClasses(hidden);
  renderLegend();
}

const fmt = (n) => Math.round(n).toLocaleString('fr-FR');
const mo = (n) => `${(n / 1e6).toFixed(2)} Mo`;

const log = (message, kind = '') => {
  const div = document.createElement('div');
  div.className = kind;
  div.textContent = message;
  el.log.appendChild(div);
};
const clearLog = () => { el.log.innerHTML = ''; };
const notice = (html, kind = '') => { el.notice.className = `show ${kind}`; el.notice.innerHTML = html; };
const hideNotice = () => { el.notice.className = ''; };

function table(target, rows) {
  target.innerHTML =
    '<table>' +
    rows.map(([k, v, kind = '']) => `<tr><td class="k">${k}</td><td class="v ${kind}">${v}</td></tr>`).join('') +
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

const index = new TileIndex();
let loader = null;
let selected = null;
let session = null;

async function makeLoader() {
  loader?.dispose();
  loader = await TileLoader.create({
    queue: new RequestQueue({ concurrency: CONCURRENCY }),
    decoder: new DecoderPool(1),
  });
  return loader;
}

/**
 * Le viewer demande les nœuds dont il a besoin ; on les charge et on les lui
 * rend au fil de l'eau. Une session porte la dalle courante : un lot arrivé
 * après un changement de lieu doit être jeté, pas ajouté à la nouvelle scène.
 */
async function serveNodes(nodes) {
  if (!session) return;
  const mine = session;
  try {
    await loader.loadNodes(mine.tile, nodes, {
      onNode: ({ node, positions, classification }) => {
        if (session !== mine) return;
        viewer.addNode(node, positions, classification);
        if (mine.firstPaintMs == null) {
          mine.firstPaintMs = performance.now() - mine.started;
          log(`première image en ${(mine.firstPaintMs / 1000).toFixed(2)} s`, 'ok');
        }
      },
    });
  } catch (error) {
    for (const node of nodes) viewer.pending.delete(node.id);
    if (session === mine) log(`nœud non chargé : ${error.message}`, 'warn');
  }
}

const viewer = new Viewer(document.getElementById('view'), {
  onRequestNodes: (nodes) => serveNodes(nodes),
  pointBudget: POINT_BUDGET,
});

function describeTile(tile, point) {
  const a = tile.acquisition;
  const season = acquisitionSeason(a);
  table(el.tile, [
    ['nom', tile.name ?? '—'],
    ['dalle', tileNameAt(point.x, point.y)],
    ['point', `${point.x.toFixed(0)} ; ${point.y.toFixed(0)}`],
    ['acquisition', a.start && a.end ? `${a.start} → ${a.end}` : (a.start ?? '<span class="warn">non renseignée</span>')],
    ['saison', season ? `<span class="warn">${season}</span>` : '—'],
    ['capteur', a.sensor ?? '—'],
    ['classement', a.classifier ?? '—'],
  ]);
}

async function pick(point) {
  hideNotice();
  clearLog();
  el.load.disabled = true;
  selected = null;
  session = null;
  viewer.clear();
  el.checks.innerHTML = '<span class="dim">—</span>';
  el.stats.innerHTML = '<span class="dim">—</span>';

  if (!isWithinMetropole(point.x, point.y)) {
    picker.select(point, null);
    el.tile.innerHTML = '<span class="dim">hors emprise du Lambert-93</span>';
    notice(
      "<b>Hors de la France métropolitaine.</b><br>Le programme couvre la métropole, la Corse " +
        'et les DROM sauf la Guyane ; cet explorateur ne gère que la projection Lambert-93.',
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
        "territoire d'une zone pas encore livrée : il répond la même chose dans les deux cas.",
      'miss',
    );
    return;
  }

  selected = { tile, point };
  describeTile(tile, point);
  el.load.disabled = false;
  log('dalle trouvée — « Charger le nuage » pour l’explorer en 3D', 'ok');
}

async function loadSelected() {
  if (!selected) return;
  el.load.disabled = true;
  clearLog();
  const started = performance.now();
  await makeLoader();

  try {
    const tile = await loader.open(selected.tile.url);
    log(`format ${tile.header.pointFormat} · ${fmt(tile.header.pointCount)} pts · ${tile.density.toFixed(1)} pts/m²`, 'ok');

    // Toute la hiérarchie, pas seulement les premiers niveaux : c'est le
    // sélecteur qui décide de la profondeur, et la lire coûte une requête.
    const { nodes, levels, pagesRead } = await loader.hierarchy(tile, { maxLevel: Infinity });
    log(`${pagesRead} page(s) · ${fmt(nodes.length)} nœuds · ${fmt(nodes.reduce((a, n) => a + n.pointCount, 0))} pts disponibles`);

    session = { tile, started, firstPaintMs: null };
    viewer.setTile(tile, nodes);

    table(el.stats, levels.map((l) => [`niveau ${l.level}`, `${fmt(l.points)} pts · ${mo(l.bytes)}`]));
    log('navigation libre — le détail se charge selon la caméra', 'ok');
    window.__session = session;
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
    if (info.error) log(`couverture indisponible : ${info.error}`, 'warn');
  },
});

el.clear.addEventListener('click', async () => {
  await (await makeLoader()).cache?.clear();
  log('cache vidé', 'warn');
});
el.load.addEventListener('click', () => loadSelected());

el.legend.addEventListener('change', (event) => {
  const code = Number(event.target.dataset.code);
  if (Number.isNaN(code)) return;
  if (event.target.checked) hidden.delete(code);
  else hidden.add(code);
  applyHidden();
});

el.presets.addEventListener('click', (event) => {
  const preset = event.target.dataset.preset;
  if (!preset) return;
  hidden.clear();
  for (const code of PRESETS[preset]) hidden.add(code);
  applyHidden();
});

// Le bandeau se rafraîchit sur horloge, pas dans la boucle de rendu : mêler
// l'affichage des mesures à ce qu'on mesure fausserait les deux.
/** Barre d'échelle : valable à la profondeur visée, ce que le libellé rappelle. */
function renderScale() {
  if (!session) { el.scale.className = ''; return; }
  const cam = viewer.camera;
  const target = viewer.controls.target;
  const distance = cam.position.distanceTo(target);
  const ppm = pixelsPerMetre({
    viewportHeight: el.scale.parentElement.clientHeight,
    fovRadians: (cam.fov * Math.PI) / 180,
    distance,
  });
  const chosen = chooseScale({ pixelsPerMetre: ppm });
  if (!chosen) { el.scale.className = ''; return; }
  const azimuth = viewAzimuth(
    [cam.position.x, cam.position.y],
    [target.x, target.y],
  );
  el.scale.className = 'show';
  el.scalebar.style.width = `${Math.round(chosen.px)}px`;
  el.scaletext.textContent =
    `${formatLength(chosen.metres)} au centre · vue vers le ${cardinal(azimuth)} (${Math.round(azimuth)}°)`;
}

setInterval(() => {
  const s = viewer.stats;
  renderScale();
  const sel = s.lastSelection;
  el.hud.innerHTML = session
    ? `<b>${fmt(s.pointsInScene)}</b> pts · <b>${s.nodesInScene}</b> nœuds en scène` +
      (sel ? ` · ${sel.selected} voulus, ${fmt(sel.points)} pts` : '') +
      ` · ${viewer.memory().geometries} géométries · ${s.evicted} évictions`
    : 'cliquez sur la carte pour choisir un lieu';

  if (session) {
    renderLegend();
    const report = loader.report();
    renderChecks([
      {
        label: 'Première image sous 1,5 s',
        pass: session.firstPaintMs != null && session.firstPaintMs < 1500,
        detail: session.firstPaintMs == null ? 'en attente…' : `${(session.firstPaintMs / 1000).toFixed(2)} s`,
      },
      {
        label: 'Points en scène sous le plafond',
        pass: s.pointsInScene <= POINT_BUDGET,
        detail: `${fmt(s.pointsInScene)} / ${fmt(POINT_BUDGET)}`,
      },
      {
        // Un simple « <= » passerait à zéro géométrie, c'est-à-dire quand rien
        // n'a encore été rendu : `renderer.info` ne compte qu'après le premier
        // envoi au GPU. On exige donc l'égalité dès qu'il y a des nœuds — c'est
        // ce qui révèle un dispose() manquant, invisible autrement.
        label: 'Géométries GPU alignées sur les nœuds affichés',
        pass:
          s.nodesInScene === 0
            ? viewer.memory().geometries === 0
            : viewer.memory().geometries === s.nodesInScene,
        detail: `${viewer.memory().geometries} géométries pour ${s.nodesInScene} nœuds · ${s.evicted} évictions`,
      },
      {
        label: 'Aucun quota dépassé',
        pass: report.queue.rateLimited === 0,
        detail: report.queue.rateLimited === 0 ? 'aucun HTTP 429' : `${report.queue.rateLimited} refus`,
      },
    ]);
  }
}, 500);

window.__viewer = viewer;
window.__hidden = hidden;
window.__applyHidden = applyHidden;
window.__renderLegend = renderLegend;
window.__renderScale = renderScale;
window.__picker = picker;
window.__index = index;
window.__pick = pick;
window.__loadSelected = loadSelected;
window.__loader = () => loader;
log('prêt — cliquez sur la carte.');
