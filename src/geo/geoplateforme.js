/**
 * Points d'entrée de la Géoplateforme de l'IGN, en un seul endroit.
 *
 * Ils étaient écrits là où on s'en sert, ce qui est naturel — mais la page doit
 * aussi *déclarer* ses sources, et une déclaration recopiée à côté du code
 * cesse d'être vraie au premier changement, sans que rien ne le signale. Ici,
 * la mention affichée et la requête émise lisent la même constante : elles ne
 * peuvent pas diverger.
 *
 * Tous ces services sont ouverts, sans clé ni compte.
 */

export const LICENCE = {
  nom: 'Licence Ouverte / Open Licence 2.0 (Etalab)',
  url: 'https://www.etalab.gouv.fr/licence-ouverte-open-licence/',
  producteur: 'IGN — Géoplateforme',
};

/** Index des dalles : quelle dalle couvre ce point, et où la télécharger. */
export const WFS = {
  endpoint: 'https://data.geopf.fr/wfs/ows',
  layer: 'IGNF_NUAGES-DE-POINTS-LIDAR-HD:dalle',
};

/** Fonds de carte, en pseudo-Mercator. */
export const WMTS = {
  endpoint: 'https://data.geopf.fr/wmts',
  plan: 'GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2',
  ortho: 'ORTHOIMAGERY.ORTHOPHOTOS',
};

/** Rasters dérivés du LiDAR HD. Les couches sont nommées dans `rasters.js`. */
export const WMS = {
  endpoint: 'https://data.geopf.fr/wms-r/wms',
};

/**
 * Les nuages eux-mêmes ne sont pas servis par une API : le WFS rend l'URL de
 * chaque dalle, et le fichier COPC est lu par requêtes `Range`. L'hôte est
 * rappelé ici pour la déclaration, jamais construit à la main — le nom du
 * fichier diffère de celui de la dalle, et le reconstruire donne un 404.
 */
export const TELECHARGEMENT = {
  hote: 'https://data.geopf.fr/telechargement/',
};
