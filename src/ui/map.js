import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { LICENCE, WMTS } from '../geo/geoplateforme.js';
import { toLambert93, toWgs84 } from '../geo/projection.js';

/**
 * Fond Plan IGN, servi en WMTS sans clé. Le jeu de tuiles « PM » est en
 * pseudo-Mercator, donc indexé exactement comme des tuiles XYZ classiques :
 * TILEMATRIX/TILEROW/TILECOL correspondent à z/y/x.
 */
const tuiles = (couche, format) =>
  `${WMTS.endpoint}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
  `&LAYER=${couche}&STYLE=normal&TILEMATRIXSET=PM` +
  `&FORMAT=${format}&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`;

const PLAN_IGN = tuiles(WMTS.plan, 'image/png');
const ORTHO_IGN = tuiles(WMTS.ortho, 'image/jpeg');

/** En deçà de ce zoom, une vue couvre trop de dalles pour qu'on les dessine. */
const COVERAGE_MIN_ZOOM = 12;
const COVERAGE_MAX_TILES = 200;

export class LocationPicker {
  constructor(container, { onPick, index, onCoverage } = {}) {
    this.index = index;
    this.onCoverage = onCoverage;

    this.map = L.map(container, { center: [43.6, 1.443], zoom: 14, zoomControl: true });

    const plan = L.tileLayer(PLAN_IGN, {
      maxZoom: 19,
      attribution: `Fond de carte et LiDAR HD : © ${LICENCE.producteur} — ${LICENCE.nom}`,
    }).addTo(this.map);
    const ortho = L.tileLayer(ORTHO_IGN, { maxZoom: 19 });
    L.control.layers({ 'Plan IGN': plan, 'Photo aérienne': ortho }, {}, { position: 'topright' }).addTo(this.map);

    this.coverageLayer = L.layerGroup().addTo(this.map);
    this.selectionLayer = L.layerGroup().addTo(this.map);
    // Dessous les deux autres : l'empreinte de la vue ne doit masquer ni la
    // dalle choisie ni les rectangles de couverture.
    this.viewLayer = L.layerGroup();
    this.viewLayer.addTo(this.map);
    this.viewLayer.bringToBack?.();

    this.map.on('click', (event) => {
      const { lat, lng } = event.latlng;
      const [x, y] = toLambert93(lng, lat);
      onPick?.({ lon: lng, lat, x, y });
    });

    // Une carte créée dans un conteneur de taille nulle — onglet en arrière-plan,
    // panneau replié — reste figée à cette taille : Leaflet ne recalcule qu'au
    // `resize` de la fenêtre, qui ne vient jamais si c'est le conteneur seul qui
    // change. Sans ceci, la carte n'affiche qu'une tuile et ne s'en remet pas.
    this._observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        this.map.invalidateSize({ animate: false });
        this.refreshCoverage();
      }
    });
    this._observer.observe(container);

    // Le survol des dalles coûte une requête WFS : on temporise, et on s'abstient
    // tant que la vue est trop large pour que le résultat ait un sens.
    let timer = null;
    this.map.on('moveend', () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.refreshCoverage(), 600);
    });
    this.refreshCoverage();
  }

  /** Emprise courante de la carte, en Lambert-93. */
  viewBounds() {
    const b = this.map.getBounds();
    const [minX, minY] = toLambert93(b.getWest(), b.getSouth());
    const [maxX, maxY] = toLambert93(b.getEast(), b.getNorth());
    return { minX, minY, maxX, maxY };
  }

  async refreshCoverage() {
    if (!this.index) return;
    const zoom = this.map.getZoom();
    if (zoom < COVERAGE_MIN_ZOOM) {
      this.coverageLayer.clearLayers();
      this.onCoverage?.({ shown: false, reason: `zoomer pour voir les dalles (niveau ≥ ${COVERAGE_MIN_ZOOM})` });
      return;
    }
    try {
      const { tiles, matched, truncated } = await this.index.findIn(this.viewBounds(), {
        limit: COVERAGE_MAX_TILES,
      });
      this.coverageLayer.clearLayers();
      for (const tile of tiles) {
        L.rectangle(this._latLngBounds(tile.bounds), {
          color: '#7fd1ff',
          weight: 1,
          opacity: 0.45,
          fillOpacity: 0.05,
          interactive: false,
        }).addTo(this.coverageLayer);
      }
      this.onCoverage?.({ shown: true, matched, truncated, drawn: tiles.length });
    } catch (error) {
      this.coverageLayer.clearLayers();
      this.onCoverage?.({ shown: false, error: error.message });
    }
  }

  _latLngBounds(bounds) {
    const [w, s] = toWgs84(bounds.minX, bounds.minY);
    const [e, n] = toWgs84(bounds.maxX, bounds.maxY);
    return [
      [s, w],
      [n, e],
    ];
  }

  /**
   * Pose sur la carte l'empreinte au sol de la vue 3D.
   *
   * Le calcul du secteur vit dans `geo/footprint.js` : ici, on ne fait que
   * dessiner. Passer `null` efface, ce qui est l'état quand aucune scène n'est
   * chargée — une empreinte qui survivrait à sa scène serait un mensonge.
   */
  showView(footprint) {
    this.viewLayer.clearLayers();
    if (!footprint) return;
    const enLatLng = (p) => { const [lon, lat] = toWgs84(p[0], p[1]); return [lat, lon]; };

    // Le fond Plan IGN est clair et chargé : un trait fin à 12 % de remplissage
    // s'y perd. Mesuré à l'écran avant de conclure — le secteur était bien
    // dessiné, sur 229 × 298 px, mais illisible.
    L.polygon(footprint.polygon.map(enLatLng), {
      color: '#1b6ea8', weight: 2, opacity: 0.95,
      fillColor: '#7fd1ff', fillOpacity: 0.22, interactive: false,
    }).addTo(this.viewLayer);

    // L'axe dit la direction du regard sans avoir à lire la forme du secteur.
    if (!footprint.zenith) {
      L.polyline([enLatLng(footprint.apex), enLatLng(footprint.target)], {
        color: '#1b6ea8', weight: 1.5, opacity: 0.8, dashArray: '4 4', interactive: false,
      }).addTo(this.viewLayer);
    }

    L.circleMarker(enLatLng(footprint.target), {
      radius: 4, color: '#0d3a58', fillColor: '#7fd1ff', fillOpacity: 1,
      weight: 1.5, interactive: false,
    }).addTo(this.viewLayer);
  }

  /** Marque le point choisi, et l'emprise de la dalle si elle existe. */
  select({ lat, lon }, tile) {
    this.selectionLayer.clearLayers();
    L.circleMarker([lat, lon], {
      radius: 5,
      color: tile ? '#7ee787' : '#ff7b72',
      fillColor: tile ? '#7ee787' : '#ff7b72',
      fillOpacity: 0.9,
      weight: 2,
    }).addTo(this.selectionLayer);

    if (tile) {
      const rect = L.rectangle(this._latLngBounds(tile.bounds), {
        color: '#7ee787',
        weight: 2,
        fillOpacity: 0.08,
      }).addTo(this.selectionLayer);
      this.map.fitBounds(rect.getBounds(), { padding: [40, 40], maxZoom: 17 });
    }
  }

  invalidate() {
    this.map.invalidateSize();
  }
}
