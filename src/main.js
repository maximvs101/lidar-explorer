import { TileLoader } from './loader.js';
import { RequestQueue } from './net/queue.js';
import { DecoderPool } from './decode/decoder.js';
import { TileIndex, acquisitionSeason } from './geo/wfs.js';
import { isWithinMetropole, tileNameAt } from './geo/projection.js';
import { LocationPicker } from './ui/map.js';
import { Viewer } from './render/viewer.js';
import { PRESETS, PRESET_NAMES } from './render/presets.js';
import { COLOR_MODES } from './render/pointsMaterial.js';
import { formatDistance, formatSlope, measureBetween, toAbsolute } from './analysis/measure.js';
import { className, shares } from './analysis/classStats.js';
import { cardinal, chooseScale, formatLength, pixelsPerMetre, viewAzimuth } from './ui/scale.js';
import { renderSources } from './ui/sources.js';

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
  levels: document.getElementById('levels'),
  sources: document.getElementById('sources'),
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
  colorMode: document.getElementById('colormode'),
  round: document.getElementById('round'),
  neighbours: document.getElementById('neighbours'),
  detail: document.getElementById('detail'),
  detailVal: document.getElementById('detailval'),
  measureBtn: document.getElementById('measure'),
  measureOut: document.getElementById('measureout'),
  measureActions: document.getElementById('measureactions'),
  measureClear: document.getElementById('measureclear'),
  progress: document.getElementById('progress'),
  progressBar: document.getElementById('progressbar'),
  progressText: document.getElementById('progresstext'),
  exportBtn: document.getElementById('export'),
  exportScale: document.getElementById('exportscale'),
  exportSize: document.getElementById('exportsize'),
};

const fmtScale = (n) => n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Preset d'affichage courant. */
let presetName = 'lecture';

/** Classes masquées, partagées entre la légende et les boutons de préréglage. */
const hidden = new Set();

/** Codes présents dans la légende affichée, pour ne la rebâtir qu'au besoin. */
let legendSignature = '';

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

  // La légende se rafraîchit deux fois par seconde. Réécrire le HTML à chaque
  // fois remplacerait les cases à cocher sous le curseur : un clic tombant
  // pendant la reconstruction viserait un élément déjà détaché du document.
  // On ne reconstruit donc la structure que si les classes changent, et on se
  // contente sinon de mettre les compteurs à jour.
  const signature = rows.map((r) => r.code).join(',') + '|' + presetName;
  if (signature !== legendSignature) {
    legendSignature = signature;
    el.legend.innerHTML = rows
      .map((r) => {
        const entree = PRESETS[presetName].palette[r.code] ?? [90, 90, 95];
        const rgb = Array.isArray(entree[0]) ? entree[0] : entree;
        return (
          `<label class="cls" data-row="${r.code}"><input type="checkbox" data-code="${r.code}">` +
          `<span class="sw" style="background:rgb(${rgb.join(',')})"></span>` +
          `<span class="nm">${r.code} ${className(r.code)}</span>` +
          `<span class="ct"></span></label>`
        );
      })
      .join('');
  }
  for (const r of rows) {
    const ligne = el.legend.querySelector(`[data-row="${r.code}"]`);
    if (!ligne) continue;
    const masquee = hidden.has(r.code);
    ligne.classList.toggle('off', masquee);
    const boite = ligne.querySelector('input');
    // Ne pas toucher à la case si elle est déjà dans le bon état : la réécrire
    // sous un curseur en train de cliquer annulerait le clic.
    if (boite.checked === masquee) boite.checked = !masquee;
    ligne.querySelector('.ct').textContent = `${fmt(r.count)} · ${r.share.toFixed(1)} %`;
  }
  // En mode hauteur, les pastilles ne décrivent plus ce qui est à l'écran : la
  // couleur vient de la hauteur au-dessus du sol. Le dire, sinon la légende
  // affirme quelque chose de faux.
  const parClasse = viewer.colorMode !== 'hauteur';
  el.legend.classList.toggle('muted', !parClasse);
  el.biais.textContent = parClasse
    ? 'Parts calculées sur les points actuellement affichés, pas sur la composition ' +
      'du terrain : elles dépendent du niveau de détail chargé (la végétation haute ' +
      'pèse jusqu’à 1,5 fois trop dans une vue d’ensemble).'
    : `Les couleurs affichées viennent de la hauteur au-dessus du sol (0 à ` +
      `${viewer.preset.heightMax ?? 30} m), pas des classes ci-dessus — les pastilles ` +
      'ne servent ici qu’à filtrer. Les comptes, eux, restent justes.';
}

function applyHidden() {
  viewer.setHiddenClasses(hidden);
  renderLegend();
}

const fmt = (n) => Math.round(n).toLocaleString('fr-FR');
const mo = (n) => `${(n / 1e6).toFixed(2)} Mo`;

const MAX_LIGNES_JOURNAL = 6;

const log = (message, kind = '') => {
  const div = document.createElement('div');
  div.className = kind;
  div.textContent = message;
  el.log.appendChild(div);
  // Le journal est une marge, pas le contenu : au-delà de quelques lignes il
  // repousse hors de l'écran ce qu'on est venu lire.
  while (el.log.children.length > MAX_LIGNES_JOURNAL) el.log.firstChild.remove();
};

/**
 * Message qui se met à jour au lieu de s'empiler.
 * Les dalles voisines arrivent une par une ; en faire une ligne chacune noyait
 * le panneau sous dix entrées disant toutes la même chose.
 */
function logCompteur(cle, texte, kind = 'dim') {
  let div = el.log.querySelector(`[data-cle="${cle}"]`);
  if (!div) {
    div = document.createElement('div');
    div.dataset.cle = cle;
    div.className = kind;
    el.log.appendChild(div);
    while (el.log.children.length > MAX_LIGNES_JOURNAL) el.log.firstChild.remove();
  }
  div.textContent = texte;
}
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

/**
 * Change de session, et avec elle la forme du panneau.
 *
 * Tant qu'aucun nuage n'est chargé, la moitié des sections n'afficherait que
 * des tirets — mesure, image, classes, réglages de chargement. Les masquer est
 * ce qui distingue un panneau lisible d'une liste de réglages inertes. Le
 * basculement passe par ici et nulle part ailleurs : deux endroits qui
 * affectent `session` finiraient par en oublier un.
 */
function setSession(next) {
  session = next;
  document.body.classList.toggle('chargee', Boolean(next));
  window.__session = next;
}

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
            onNode: ({ node, positions, classification, intensity, returns, source }) => {
              if (session !== mine || !viewer.hasTile(tileKey)) return;
              viewer.addNode(
                { uid: `${tileKey}|${node.id}`, tileKey, node },
                positions, classification, { intensity, returns, source },
              );
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
let voisines = 0;

async function extendToNeighbours() {
  if (!session || !viewer.sceneOrigin || extendToNeighbours.busy) return;
  if (!el.neighbours.checked) return;
  extendToNeighbours.busy = true;
  try {
    const [ox, oy] = viewer.sceneOrigin;
    const target = viewer.controls.target;
    const cx = target.x + ox;
    const cy = target.y + oy;
    const reach = Math.min(Math.max(viewer.camera.position.distanceTo(target), 300), 2500);
    const bbox = { minX: cx - reach, minY: cy - reach, maxX: cx + reach, maxY: cy + reach };

    const { tiles } = await index.findIn(bbox, { limit: 32 });
    if (!session || !el.neighbours.checked) return;

    // Les plus proches du point vise d'abord : c'est la que le detail compte.
    const distance = (t) =>
      Math.hypot((t.bounds.minX + t.bounds.maxX) / 2 - cx, (t.bounds.minY + t.bounds.maxY) / 2 - cy);
    const wanted = tiles.sort((a, b) => distance(a) - distance(b)).slice(0, MAX_TILES);
    const wantedUrls = new Set(wanted.map((t) => t.url));

    for (const key of [...viewer.tiles.keys()]) {
      if (!wantedUrls.has(key)) viewer.removeTile(key);
    }

    for (const descriptor of wanted) {
      // L'option est relue a chaque tour, pas seulement a l'entree : cette
      // boucle attend le reseau a deux endroits, et la decocher pendant qu'elle
      // tourne laissait les dalles continuer d'arriver apres le repli.
      if (!el.neighbours.checked) return;
      if (viewer.hasTile(descriptor.url)) continue;
      const opened = await loader.open(descriptor.url);
      if (!session || !el.neighbours.checked || viewer.hasTile(descriptor.url)) continue;
      const { nodes } = await loader.hierarchy(opened, { maxLevel: Infinity });
      if (!session || !el.neighbours.checked) return;
      viewer.addTile(opened, nodes);
      voisines += 1;
      logCompteur('voisines', `${voisines} dalle${voisines > 1 ? 's' : ''} voisine${voisines > 1 ? 's' : ''} ajoutée${voisines > 1 ? 's' : ''}`);
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
  el.measureBtn.disabled = true;
  setMeasuring(false);
  selected = null;
  setSession(null);
  viewer.clear();
  legendSignature = '';
  el.checks.innerHTML = '<span class="dim">—</span>';
  el.stats.innerHTML = '';
  el.levels.innerHTML = '';

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
  el.load.textContent = 'Chargement…';
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

    voisines = 0;
    setSession({ tile, started, firstPaintMs: null });
    viewer.setTile(tile, nodes);
    extendToNeighbours();

    table(el.levels, levels.map((l) => [`niveau ${l.level}`, `${fmt(l.points)} pts · ${mo(l.bytes)}`]));
    el.exportBtn.disabled = false;
    el.measureBtn.disabled = false;
    showExportSize();
    log('navigation libre — le détail se charge selon la caméra', 'ok');
  } catch (error) {
    log(`échec : ${error.message}`, 'err');
    notice(`<b>Le chargement a échoué.</b><br>${error.message}`, 'miss');
  } finally {
    el.load.disabled = false;
    el.load.textContent = 'Charger le nuage';
  }
}

const picker = new LocationPicker(document.getElementById('map'), {
  index,
  onPick: (point) => pick(point).catch((e) => log(`échec : ${e.message}`, 'err')),
  onCoverage: (info) => {
    if (info.error) log(`couverture indisponible : ${info.error}`, 'warn');
  },
});

/**
 * Mesure entre deux points cliqués.
 *
 * Le premier clic pose l'origine, le second referme la mesure, un troisième
 * repart de zéro. Les coordonnées sont rendues en Lambert-93 et NGF-IGN69 :
 * une mesure qui ne peut pas se reporter sur une carte ne sert à rien.
 */
let measuring = false;
let picks = [];

function setMeasuring(on) {
  measuring = on;
  el.measureBtn.classList.toggle('on', on);
  el.measureBtn.textContent = on ? 'Mesurer — actif' : 'Mesurer';
  document.getElementById('stage').classList.toggle('measuring', on);
  // Quitter le mode de saisie ne doit PAS effacer la mesure : on en sort
  // précisément pour naviguer autour sans risquer de poser un point de plus.
  // L'effacement devient un geste explicite.
  if (!on) {
    if (picks.length === 0) el.measureOut.innerHTML = '<span class="dim">—</span>';
  } else {
    // Le mode change ce que fait le clic gauche : il faut le dire, sinon
    // l'utilisateur croit avoir cassé la rotation de la vue.
    el.measureOut.innerHTML =
      '<span class="dim">cliquez un premier point — glisser fait toujours ' +
      'tourner la vue, seul un clic immobile pose un point. Échap pour sortir.</span>';
  }
}

function renderMeasure() {
  const origine = viewer.sceneOrigin ?? [0, 0, 0];
  const a = toAbsolute(picks[0], origine);
  if (picks.length === 1) {
    table(el.measureOut, [
      ['point A', `${a.x.toFixed(1)} ; ${a.y.toFixed(1)}`],
      ['altitude A', `${a.z.toFixed(2)} m NGF`],
      ['', '<span class="dim">cliquez un second point</span>'],
    ]);
    return;
  }
  const b = toAbsolute(picks[1], origine);
  const m = measureBetween(a, b);
  table(el.measureOut, [
    ['distance', `<b>${formatDistance(m.distance)}</b>`],
    ['horizontale', formatDistance(m.horizontal)],
    ['dénivelé', formatDistance(m.dz)],
    ['pente', formatSlope(m.slopePercent, m.slopeDegrees)],
    ['azimut', Number.isFinite(m.azimuth) ? `${m.azimuth.toFixed(1)}°` : '—'],
    ['altitude A', `${a.z.toFixed(2)} m NGF`],
    ['altitude B', `${b.z.toFixed(2)} m NGF`],
  ]);
}

el.measureBtn.addEventListener('click', () => setMeasuring(!measuring));

el.measureClear.addEventListener('click', () => {
  picks = [];
  viewer.clearMeasure();
  el.measureOut.innerHTML = measuring
    ? '<span class="dim">cliquez un premier point</span>'
    : '<span class="dim">—</span>';
  el.measureActions.hidden = true;
});

/**
 * Distinguer le clic du glissement.
 *
 * Le même bouton gauche fait tourner la vue et pose un point, et le navigateur
 * émet un `click` même après un déplacement : sans cette distinction, chaque
 * rotation de la caméra posait un point. On compare donc la position d'appui à
 * celle du relâchement, avec une tolérance de quelques pixels — personne ne
 * clique parfaitement immobile.
 */
const CLIC_TOLERANCE = 5;
let appui = null;
const vue = document.getElementById('view');

vue.addEventListener('pointerdown', (event) => {
  appui = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
});

vue.addEventListener('pointerup', (event) => {
  const depart = appui;
  appui = null;
  if (!depart || event.button !== 0) return;
  if (Math.hypot(event.clientX - depart.x, event.clientY - depart.y) > CLIC_TOLERANCE) return;
  if (!measuring || !session) return;

  const point = viewer.pickAt(event.clientX, event.clientY);
  if (!point) {
    el.measureOut.innerHTML = '<span class="dim">aucun point à cet endroit — visez la surface</span>';
    return;
  }
  if (picks.length >= 2) picks = [];
  picks.push(point);
  viewer.showMeasure(picks);
  el.measureActions.hidden = false;
  renderMeasure();
});

// Échap sort du mode mesure : c'est le réflexe, et le bouton est loin du curseur.
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && measuring) setMeasuring(false);
});

el.clear.addEventListener('click', async () => {
  // Destructif et sans intérêt courant : tout devra être retéléchargé, et la
  // Géoplateforme plafonne les requêtes. Une confirmation n'est pas de trop.
  if (!window.confirm('Vider le cache ? Les dalles déjà lues devront être retéléchargées.')) return;
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
  // Le sélecteur reflète le mode que le preset vient d'installer.
  el.colorMode.value = Object.keys(COLOR_MODES)
    .find((k) => COLOR_MODES[k] === viewer.materials.shared.uColorMode) ?? 'classe';
  el.round.checked = viewer.materials.shared.uRound > 0.5;
  el.pointSize.value = String(viewer.pointScale);
  el.pointSizeVal.textContent = fmtScale(viewer.pointScale);
  renderLegend();
}

el.detail.addEventListener('input', () => {
  const px = Number(el.detail.value);
  viewer.setDetail(px);
  el.detailVal.textContent = `${px.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} px`;
});

// Carré ou rond : un point OpenGL est un quad, le rond demande de rejeter les
// pixels hors du disque. Le carré avait été retenu du temps où les points
// étaient grossis et laissaient voir le fond entre eux ; mesure faite depuis
// que ce grossissement a disparu, l'écart de trous ne dépasse plus 0,18 point.
// Le choix est donc devenu esthétique, et il revient à qui regarde.
el.colorMode.addEventListener('change', () => {
  const mode = el.colorMode.value;
  if (mode === 'hauteur') {
    viewer.buildTerrain({ force: true });
    viewer.loadRaster('mnh');
  }
  viewer.materials.setColorMode(mode);
  if (mode === 'intensite') viewer.autoIntensityRange();
  // Le mode retenu peut différer du mode demandé : la hauteur exige un terrain,
  // et sans lui le rendu retombe sur la couleur de classe.
  el.colorMode.value = Object.keys(COLOR_MODES)
    .find((k) => COLOR_MODES[k] === viewer.materials.shared.uColorMode) ?? 'classe';
  renderLegend();
});

el.round.addEventListener('change', () => {
  viewer.materials.setRound(el.round.checked);
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
  if (!session || !el.neighbours.checked) return;
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

/**
 * Ramène la scène à la seule dalle choisie sur la carte.
 *
 * Décocher l'option doit défaire ce qu'elle avait fait, sinon les voisines déjà
 * chargées resteraient là et le réglage aurait l'air de ne rien faire.
 *
 * La dalle d'origine peut avoir été relâchée si la vue s'en est éloignée — le
 * chargement ne garde que les plus proches du point visé. On retombe alors sur
 * la plus proche de ce qui reste, plutôt que de vider la scène.
 */
function collapseToSingleTile() {
  if (!session || viewer.tiles.size <= 1) return;
  const cible = viewer.controls.target;

  let garde = viewer.hasTile(session.tile.url) ? session.tile.url : null;
  if (!garde) {
    let meilleure = Infinity;
    for (const [cle, entry] of viewer.tiles) {
      const d = Math.hypot(entry.localCenter[0] - cible.x, entry.localCenter[1] - cible.y);
      if (d < meilleure) { meilleure = d; garde = cle; }
    }
  }
  for (const cle of [...viewer.tiles.keys()]) {
    if (cle !== garde) viewer.removeTile(cle);
  }
  voisines = 0;
  logCompteur('voisines', 'voisines relâchées — dalle seule');
}

el.neighbours.addEventListener('change', () => {
  if (el.neighbours.checked) {
    // La signature de vue est remise à zéro : sans cela, `maybeExtend`
    // considérerait que rien n'a bougé et n'irait rien chercher avant le
    // prochain déplacement de caméra.
    lastReach = null;
    extendToNeighbours();
  } else {
    collapseToSingleTile();
  }
});

/**
 * Où en est le chargement.
 *
 * Le nombre de points en scène ne dit rien à lui seul : il faut savoir s'il va
 * encore monter. On rapporte donc le chargé au voulu, et la barre disparaît une
 * fois à jour plutôt que de rester à 100 % — un indicateur qui ne bouge plus
 * n'informe plus.
 */
function renderProgress() {
  if (!session) { el.progress.className = ''; return; }
  const p = viewer.progress();
  if (p.done) {
    el.progress.className = '';
    return;
  }
  el.progress.className = 'show';
  el.progressBar.style.width = `${Math.round(100 * p.ratio)} %`.replace(' ', '');
  el.progressText.textContent =
    `chargement ${Math.round(100 * p.ratio)} % · ${fmt(p.loaded)} / ${fmt(p.wanted)} pts` +
    (p.pending > 0 ? ` · ${p.pending} en vol` : '');
}

/**
 * D'où vient le sol sous les points, en clair.
 *
 * Le MNT officiel est dérivé de la totalité des points de la dalle ; notre
 * grille ne voit que le niveau de détail chargé et comble le reste par
 * diffusion. La différence n'est pas cosmétique : sous un couvert dense, l'un
 * mesure là où l'autre estime. L'afficher évite de prêter au second la
 * précision du premier.
 */
function sourceTerrain() {
  switch (viewer.rasterStatus('mnt')) {
    case 'officiel':
      return { libelle: `MNT IGN · ${viewer.rasterCells} px`, warn: false };
    case 'chargement':
      return { libelle: 'points de sol (MNT en cours…)', warn: false };
    case 'absent':
      return { libelle: 'points de sol — MNT non couvert ici', warn: true };
    case 'erreur':
      return { libelle: 'points de sol — MNT indisponible', warn: true };
    default:
      return { libelle: 'points de sol', warn: false };
  }
}

/** État d'un raster secondaire, en une ligne de tableau. */
function etatRaster(produit) {
  switch (viewer.rasterStatus(produit)) {
    case 'officiel': return { libelle: 'disponible', warn: false };
    case 'chargement': return { libelle: 'chargement…', warn: false };
    case 'absent': return { libelle: 'non couvert ici', warn: true };
    case 'erreur': return { libelle: 'indisponible', warn: true };
    default: return { libelle: '—', warn: false };
  }
}

setInterval(() => {
  const s = viewer.stats;
  renderProgress();
  renderScale();
  maybeExtend();
  const sel = s.lastSelection;
  // En mode canopée, on affiche ce que la mesure vaut : la part de terrain
  // réellement observée. Sous couvert dense elle chute, et les hauteurs
  // deviennent des estimations — le taire serait donner du chiffre pour du fait.
  if (session && viewer.colorMode === 'hauteur') {
    const t = viewer.terrainStats;
    const c = viewer.canopyStats();
    const ref = viewer.canopyReference();
    const etatMnh = etatRaster('mnh');
    // Mesurée autour du point visé, sur 400 m : c'est cette part-là qui dit si
    // les hauteurs affichées reposent sur du sol vu ou sur une interpolation.
    const cible = viewer.controls.target;
    const local = viewer.terrain?.filled
      ? viewer.terrain.coverageWithin([cible.x, cible.y], 400)
      : null;
    // Deux sources possibles sous les mêmes chiffres : les confondre ferait
    // passer une estimation par diffusion pour un relevé au demi-mètre.
    const src = sourceTerrain();
    table(el.stats, [
      ['source du sol', src.libelle, src.warn ? 'warn' : ''],
      ['terrain observé ici', local ? `${(100 * local.ratio).toFixed(1)} %` : '—',
        local && local.ratio < 0.35 ? 'warn' : ''],
      ['— sur toute la grille', t ? `${(100 * t.coverage).toFixed(1)} %` : '—'],
      ['maille', t ? `${t.step.toFixed(1)} m` : '—'],
      ['cellules comblées', t ? fmt(t.filled - t.observed) : '—'],
      ['cellules sans terrain', t ? fmt(t.restants) : '—', t && t.restants > 0 ? 'warn' : ''],
      ['végétation mesurée', c ? fmt(c.count) : '—'],
      ['sans sol connu', c ? fmt(c.unknown) : '—', c && c.unknown > 0 ? 'warn' : ''],
      ['hauteur médiane des cimes', c && Number.isFinite(c.p99) ? `${c.p99.toFixed(1)} m` : '—'],
      ['hauteur maximale', c && Number.isFinite(c.max) ? `${c.max.toFixed(1)} m` : '—'],
      ['échelle de couleur', `0 → ${viewer.preset.heightMax ?? 30} m`],
      // Le MNH décrit toute l'emprise au même pas, quel que soit le niveau de
      // détail chargé. Les chiffres au-dessus, eux, ne portent que sur les
      // points affichés — deux valeurs proches disent que l'affichage est
      // représentatif, deux valeurs qui divergent disent qu'il ne l'est pas.
      ['— référence MNH', ref ? `${ref.size} m autour du point visé` : etatMnh.libelle,
        etatMnh.warn ? 'warn' : ''],
      ['cellules > 2 m', ref ? `${fmt(ref.count)} / ${fmt(ref.total)}` : '—'],
      ['— médiane', ref && Number.isFinite(ref.median) ? `${ref.median.toFixed(1)} m` : '—'],
      ['— p99', ref && Number.isFinite(ref.p99) ? `${ref.p99.toFixed(1)} m` : '—'],
      ['— maximum', ref && Number.isFinite(ref.max) ? `${ref.max.toFixed(1)} m` : '—'],
    ]);
  }

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
        // Le plafond respecté ne dit pas qu'il ne gêne pas. Mesuré au seuil de
        // détail minimal : 3 991 352 points sur 4 000 000, donc le contrôle
        // passe, alors que 14 nœuds ont été écartés faute de place. Sans ce
        // décompte, rien ne distingue « le seuil décide » de « le plafond
        // décide » — et abaisser encore le seuil n'aurait plus aucun effet.
        label: 'Plafond de points non contraignant',
        pass: (s.lastSelection?.rejected?.budget ?? 0) === 0,
        detail: `${fmt(s.pointsInScene)} / ${fmt(POINT_BUDGET)}`
          + (s.lastSelection?.rejected?.budget
            ? ` · ${s.lastSelection.rejected.budget} nœuds écartés faute de place`
            : ''),
      },
      {
        // Un simple « <= » passerait à zéro géométrie, c'est-à-dire quand rien
        // n'a encore été rendu : `renderer.info` ne compte qu'après le premier
        // envoi au GPU. On exige donc l'égalité dès qu'il y a des nœuds — c'est
        // ce qui révèle un dispose() manquant, invisible autrement.
        label: 'Géométries GPU alignées sur les nœuds affichés',
        // Le quad plein écran de la passe de relief est une géométrie de plus,
        // qui n'est pas un nœud : sans ce décompte il passerait pour une fuite.
        pass:
          s.nodesInScene === 0
            ? viewer.memory().geometries === viewer.extraGeometries
            : viewer.memory().geometries === s.nodesInScene + viewer.extraGeometries,
        detail:
          `${viewer.memory().geometries} géométries pour ${s.nodesInScene} nœuds` +
          (viewer.extraGeometries ? ' + relief' : '') + ` · ${s.evicted} évictions`,
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
window.__setNeighbours = (on) => {
  el.neighbours.checked = on;
  el.neighbours.dispatchEvent(new Event('change'));
};
window.__setPreset = setPreset;
window.__setMeasuring = setMeasuring;
window.__picks = () => picks;
window.__setPointScale = (f) => { el.pointSize.value = String(f); el.pointSize.dispatchEvent(new Event('input')); };
window.__picker = picker;
window.__index = index;
window.__pick = pick;
window.__loadSelected = loadSelected;
window.__loader = () => loader;
// La déclaration des sources est écrite une fois, au démarrage : elle ne
// dépend d'aucun état de la session, et rien de ce qu'elle nomme ne change
// en cours de route.
renderSources(el.sources);

log('prêt — cliquez sur la carte.');
