import { TileLoader } from './loader.js';
import { RequestQueue } from './net/queue.js';
import { DecoderPool } from './decode/decoder.js';
import { TileIndex, acquisitionSeason } from './geo/wfs.js';
import { isWithinMetropole, tileNameAt } from './geo/projection.js';
import { LocationPicker } from './ui/map.js';
import { Viewer } from './render/viewer.js';
import { PRESETS, PRESET_NAMES } from './render/presets.js';
import { className, shares } from './analysis/classStats.js';
import { cardinal, chooseScale, formatLength, pixelsPerMetre, viewAzimuth } from './ui/scale.js';

const CONCURRENCY = 4;
const POINT_BUDGET = 4_000_000;
/** Dalles simultanement en scene. Au-dela, les plus eloignees sont relachees. */
const MAX_TILES = 9;

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
  modes: document.getElementById('modes'),
  pointSize: document.getElementById('pointsize'),
  pointSizeVal: document.getElementById('pointsizeval'),
  detail: document.getElementById('detail'),
  detailVal: document.getElementById('detailval'),
  exportBtn: document.getElementById('export'),
  exportScale: document.getElementById('exportscale'),
  exportSize: document.getElementById('exportsize'),
};

const fmtScale = (n) => n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Preset d'affichage courant. */
let presetName = 'lecture';

/** Classes masquées, partagées entre la légende et les boutons de préréglage. */
const hidden = new Set();

/** Filtres rapides de classes — sans rapport avec les presets d'affichage. */
const CLASS_FILTERS = {
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
      // Une entrée peut être une liste de couleurs : la pastille montre la
      // première, sans quoi elle afficherait « rgb(255,200,87,233,114,76…) ».
      const entree = PRESETS[presetName].palette[r.code] ?? [90, 90, 95];
      const rgb = Array.isArray(entree[0]) ? entree[0] : entree;
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
async function serveNodes(requests) {
  if (!session) return;
  const mine = session;

  // Les demandes peuvent porter sur plusieurs dalles : on les regroupe, chaque
  // lot etant lu dans le fichier qui lui correspond.
  const byTile = new Map();
  for (const request of requests) {
    if (!byTile.has(request.tileKey)) byTile.set(request.tileKey, []);
    byTile.get(request.tileKey).push(request);
  }

  await Promise.all(
    [...byTile.entries()].map(async ([tileKey, group]) => {
      const entry = viewer.tiles.get(tileKey);
      if (!entry) {
        for (const request of group) viewer.pending.delete(request.uid);
        return;
      }
      try {
        await loader.loadNodes(
          entry.tile,
          group.map((request) => request.node),
          {
            origin: viewer.sceneOrigin,
            onNode: ({ node, positions, classification }) => {
              if (session !== mine || !viewer.hasTile(tileKey)) return;
              viewer.addNode({ uid: `${tileKey}|${node.id}`, tileKey, node }, positions, classification);
              if (mine.firstPaintMs == null) {
                mine.firstPaintMs = performance.now() - mine.started;
                log(`première image en ${(mine.firstPaintMs / 1000).toFixed(2)} s`, 'ok');
              }
            },
          },
        );
      } catch (error) {
        for (const request of group) viewer.pending.delete(request.uid);
        if (session === mine) log(`nœud non chargé : ${error.message}`, 'warn');
      }
    }),
  );
}

/**
 * Etend la scene aux dalles voisines visibles, et relache les plus lointaines.
 *
 * L'emprise interrogee est un carre centre sur le point vise, de demi-cote egal
 * a la distance de la camera : c'est une approximation du champ de vision, mais
 * elle a l'avantage de ne pas s'effondrer quand la camera regarde a l'horizon,
 * ou la projection exacte du frustum au sol part a l'infini.
 */
async function extendToNeighbours() {
  if (!session || !viewer.sceneOrigin || extendToNeighbours.busy) return;
  extendToNeighbours.busy = true;
  try {
    const [ox, oy] = viewer.sceneOrigin;
    const target = viewer.controls.target;
    const cx = target.x + ox;
    const cy = target.y + oy;
    const reach = Math.min(Math.max(viewer.camera.position.distanceTo(target), 300), 2500);
    const bbox = { minX: cx - reach, minY: cy - reach, maxX: cx + reach, maxY: cy + reach };

    const { tiles } = await index.findIn(bbox, { limit: 32 });
    if (!session) return;

    // Les plus proches du point vise d'abord : c'est la que le detail compte.
    const distance = (t) =>
      Math.hypot((t.bounds.minX + t.bounds.maxX) / 2 - cx, (t.bounds.minY + t.bounds.maxY) / 2 - cy);
    const wanted = tiles.sort((a, b) => distance(a) - distance(b)).slice(0, MAX_TILES);
    const wantedUrls = new Set(wanted.map((t) => t.url));

    for (const key of [...viewer.tiles.keys()]) {
      if (!wantedUrls.has(key)) viewer.removeTile(key);
    }

    for (const descriptor of wanted) {
      if (viewer.hasTile(descriptor.url)) continue;
      const opened = await loader.open(descriptor.url);
      if (!session || viewer.hasTile(descriptor.url)) continue;
      const { nodes } = await loader.hierarchy(opened, { maxLevel: Infinity });
      if (!session) return;
      viewer.addTile(opened, nodes);
      log(`dalle voisine ajoutée : ${descriptor.name ?? descriptor.url.slice(-28)}`, 'dim');
    }
  } catch (error) {
    log(`voisines indisponibles : ${error.message}`, 'warn');
  } finally {
    extendToNeighbours.busy = false;
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
  el.exportBtn.disabled = true;
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
    extendToNeighbours();

    table(el.stats, levels.map((l) => [`niveau ${l.level}`, `${fmt(l.points)} pts · ${mo(l.bytes)}`]));
    el.exportBtn.disabled = false;
    showExportSize();
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

/** Taille de l'image qui sera produite, pour que le choix soit informé. */
function showExportSize() {
  const canvas = viewer.renderer.domElement;
  const scale = Number(el.exportScale.value);
  el.exportSize.textContent =
    canvas.width > 1 ? `${Math.round(canvas.width * scale)} × ${Math.round(canvas.height * scale)} px` : '';
}
el.exportScale.addEventListener('change', showExportSize);

el.exportBtn.addEventListener('click', async () => {
  el.exportBtn.disabled = true;
  const libelle = el.exportBtn.textContent;
  el.exportBtn.textContent = 'rendu…';
  try {
    const { blob, width, height } = await viewer.capture({ scale: Number(el.exportScale.value) });
    const nom = viewer.captureName('png');
    const url = URL.createObjectURL(blob);
    const lien = document.createElement('a');
    lien.href = url;
    lien.download = nom;
    lien.click();
    // Laisser au navigateur le temps de lire le blob avant de le libérer.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    log(`image exportée : ${nom} — ${width} × ${height}, ${(blob.size / 1e6).toFixed(1)} Mo`, 'ok');
    window.__lastExport = { nom, width, height, size: blob.size };
  } catch (error) {
    log(`export impossible : ${error.message}`, 'err');
  } finally {
    el.exportBtn.textContent = libelle;
    el.exportBtn.disabled = false;
  }
});

function setPreset(name) {
  presetName = PRESETS[name] ? name : 'lecture';
  viewer.applyPreset(presetName);
  for (const button of el.modes.querySelectorAll('button')) {
    button.classList.toggle('on', button.dataset.preset === presetName);
  }
  const bg = PRESETS[presetName].background.toString(16).padStart(6, '0');
  document.getElementById('stage').style.background = `#${bg}`;
  // Chaque preset a sa taille de points ; le curseur suit le preset choisi
  // plutot que d'imposer un reglage a tous.
  el.pointSize.value = String(viewer.pointScale);
  el.pointSizeVal.textContent = fmtScale(viewer.pointScale);
  renderLegend();
}

el.detail.addEventListener('input', () => {
  const px = Number(el.detail.value);
  viewer.setDetail(px);
  el.detailVal.textContent = `${px.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} px`;
});

el.pointSize.addEventListener('input', () => {
  const factor = Number(el.pointSize.value);
  viewer.setPointScale(factor);
  el.pointSizeVal.textContent = fmtScale(factor);
});

el.modes.innerHTML = PRESET_NAMES.map(
  (n) => `<button data-preset="${n}"${n === presetName ? ' class="on"' : ''}>${PRESETS[n].label}</button>`,
).join('');
el.modes.addEventListener('click', (event) => {
  const name = event.target.dataset?.preset;
  if (name) setPreset(name);
});

/** Compatibilité avec les vérifications déjà écrites. */
const setMode = (on) => setPreset(on ? 'maquette' : 'lecture');

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
  for (const code of CLASS_FILTERS[preset]) hidden.add(code);
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

/** Ne réinterroge l'index que si la vue a réellement bougé. */
let lastReach = null;
function maybeExtend() {
  if (!session) return;
  const target = viewer.controls.target;
  const signature = [
    Math.round(target.x / 100),
    Math.round(target.y / 100),
    Math.round(viewer.camera.position.distanceTo(target) / 100),
  ].join(',');
  if (signature === lastReach) return;
  lastReach = signature;
  extendToNeighbours();
}

setInterval(() => {
  const s = viewer.stats;
  renderScale();
  maybeExtend();
  const sel = s.lastSelection;
  el.hud.innerHTML = session
    ? `<b>${fmt(s.pointsInScene)}</b> pts · <b>${s.nodesInScene}</b> nœuds · ` +
      `<b>${viewer.tiles.size}</b> dalle${viewer.tiles.size > 1 ? 's' : ''}` +
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
        // Le socle du mode maquette est une géométrie de plus, qui n'est pas un
        // nœud : sans ce décompte il passerait pour une fuite.
        pass:
          s.nodesInScene === 0
            ? viewer.memory().geometries === viewer.extraGeometries
            : viewer.memory().geometries === s.nodesInScene + viewer.extraGeometries,
        detail:
          `${viewer.memory().geometries} géométries pour ${s.nodesInScene} nœuds` +
          (viewer.extraGeometries ? ' + socle' : '') + ` · ${s.evicted} évictions`,
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
window.__extend = extendToNeighbours;
window.__maybeExtend = maybeExtend;
window.__setMode = setMode;
window.__setPreset = setPreset;
window.__setPointScale = (f) => { el.pointSize.value = String(f); el.pointSize.dispatchEvent(new Event('input')); };
window.__picker = picker;
window.__index = index;
window.__pick = pick;
window.__loadSelected = loadSelected;
window.__loader = () => loader;
log('prêt — cliquez sur la carte.');
