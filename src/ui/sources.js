/**
 * Déclaration des sources, telle que la page l'affiche.
 *
 * Rien ici n'est recopié : chaque adresse et chaque nom de couche est la
 * constante que le code appelle réellement. Une déclaration copiée à côté du
 * code cesse d'être vraie au premier changement, sans erreur ni diff — et une
 * mention de source fausse est pire que pas de mention du tout.
 *
 * Les versions des bibliothèques, elles, sont lues dans `package.json` au
 * moment du build : les écrire à la main revenait à annoncer une version qu'on
 * n'utilise plus dès la mise à jour suivante.
 */

import { LICENCE, TELECHARGEMENT, WFS, WMS, WMTS } from '../geo/geoplateforme.js';
import { PRODUITS } from '../analysis/rasters.js';
import versions from '../../package.json';

/** Ce que la page va chercher chez l'IGN, service par service. */
export const DONNEES = [
  {
    titre: 'Nuages de points LiDAR HD',
    detail: 'fichiers COPC lus par requêtes Range, sans téléchargement complet',
    service: 'HTTP',
    adresse: TELECHARGEMENT.hote,
    couches: [],
  },
  {
    titre: 'Index des dalles',
    detail: 'quelle dalle couvre ce point, son URL et ses métadonnées d’acquisition',
    service: 'WFS 2.0',
    adresse: WFS.endpoint,
    couches: [WFS.layer],
  },
  {
    titre: 'Modèles dérivés du LiDAR HD',
    detail: 'terrain et hauteur de végétation, en float32 au pas de 50 cm',
    service: 'WMS 1.3.0',
    adresse: WMS.endpoint,
    couches: Object.values(PRODUITS).map((p) => p.layer),
  },
  {
    titre: 'Fonds de carte',
    detail: 'Plan IGN et photographie aérienne, pour choisir un lieu',
    service: 'WMTS 1.0.0',
    adresse: WMTS.endpoint,
    couches: [WMTS.plan, WMTS.ortho],
  },
];

/**
 * Bibliothèques embarquées dans la page, et leur licence.
 *
 * Les licences sont déclarées ici parce que ce sont des faits juridiques qui ne
 * changent pas avec la version ; les numéros de version, eux, viennent du
 * `package.json` réel.
 */
export const LOGICIELS = [
  { nom: 'Three.js', paquet: 'three', licence: 'MIT', role: 'rendu WebGL' },
  { nom: 'laz-perf', paquet: 'laz-perf', licence: 'Apache-2.0', role: 'décodage LAZ en WebAssembly' },
  { nom: 'Leaflet', paquet: 'leaflet', licence: 'BSD-2-Clause', role: 'carte de sélection' },
  { nom: 'proj4', paquet: 'proj4', licence: 'MIT', role: 'projection Lambert-93' },
].map((l) => ({
  // Le nom du paquet est déclaré, jamais deviné : une règle qui dérivait le nom
  // npm du nom affiché ne marchait que pour ces quatre-là, et se serait trompée
  // en silence sur le cinquième. Et pas de valeur de repli : un paquet
  // introuvable doit rendre `undefined` et faire échouer le contrôle, pas
  // afficher un numéro de version inventé.
  ...l,
  version: versions.dependencies[l.paquet].replace(/^[\^~]/, ''),
}));

export { LICENCE };

/**
 * Échappement du texte inséré dans la page.
 *
 * Ce que la déclaration affiche vient de constantes du dépôt, donc rien
 * d'hostile aujourd'hui. Mais une fonction qui construit du HTML en faisant
 * confiance à sa source devient une injection le jour où la source change — et
 * ce jour-là, personne ne relira ce fichier.
 */
export const echappe = (texte) => String(texte).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

/** Rend la déclaration dans un conteneur. */
export function renderSources(element) {
  const donnees = DONNEES.map((d) => `
    <div class="src">
      <div class="src-t">${echappe(d.titre)}</div>
      <div class="src-d">${echappe(d.detail)}</div>
      <div class="src-u">${echappe(d.service)} · ${echappe(d.adresse)}</div>
      ${d.couches.map((c) => `<div class="src-l">${echappe(c)}</div>`).join('')}
    </div>`).join('');

  const logiciels = LOGICIELS
    .map((l) => `${echappe(l.nom)} ${echappe(l.version)} <span class="dim">(${echappe(l.licence)})</span>`)
    .join(' · ');

  element.innerHTML = `
    <p class="foot" style="margin-top:0">
      Toutes les données proviennent de l’<b>${echappe(LICENCE.producteur)}</b> et sont diffusées
      sous <a href="${echappe(LICENCE.url)}" target="_blank" rel="noopener">${echappe(LICENCE.nom)}</a>.
      Elles sont lues directement par le navigateur : aucun serveur intermédiaire,
      aucune clé d’accès, rien n’est réhébergé.
    </p>
    ${donnees}
    <p class="foot">Logiciels embarqués : ${logiciels}.</p>`;
}
