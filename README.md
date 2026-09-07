# Explorateur LiDAR HD

Explorer le nuage de points LiDAR HD de l'IGN directement dans le navigateur, et
en tirer des rendus de maquette.

Les dalles sont diffusées au format **COPC**, le serveur de la Géoplateforme
honore les requêtes `Range` et renvoie `access-control-allow-origin: *` : la page
lit donc les données **directement chez l'IGN**, sans backend ni copie locale.
L'octree du format fournit le niveau de détail — deux requêtes et 46 Ko donnent
la structure d'une dalle de 171 Mo.

## Lancer

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # 99 tests
npm run build
```

Cliquer sur la carte pour choisir un lieu, puis « Charger le nuage ». Le détail
se raffine selon la caméra, et les dalles voisines se chargent au déplacement.

## Ce que ça fait

- **Sélection par la carte** — index des dalles via le WFS public de la
  Géoplateforme, fond Plan IGN, métadonnées d'acquisition affichées (dates,
  capteur, procédé de classement).
- **Niveau de détail piloté par la caméra**, plafonné en nombre de points, avec
  éviction des nœuds hors champ.
- **Filtres de classe** instantanés : la classification vit sur le GPU, un octet
  par point indexant une palette.
- **Coloration au choix** — par classe, par **intensité** (réflectance, bornée
  automatiquement sur les centiles de la zone chargée), par **nombre de retours**
  (un tir multi-écho a traversé du feuillage), par **bande de vol** (les passes
  de l'avion se recouvrent, ce qui explique une densité trois fois supérieure à
  celle annoncée), par hauteur au-dessus du sol, ou en mode audit.
- **Quatre presets** — lecture, relief, canopée, audit. L'éclairage de
  profondeur et l'ombrage directionnel rendent le relief lisible sur un nuage
  qui, faute de normales, paraîtrait plat.

## Points de vigilance

- La **saison d'acquisition** change tout à la végétation : un relevé feuilles
  tombées ne montre pas la même canopée qu'un relevé de juin. La date figure
  dans le panneau.
- Les **parts de classes affichées** portent sur les points chargés, pas sur la
  composition du terrain. Mesuré sur emprise identique, la végétation haute pèse
  24,3 % au niveau 2 de l'octree contre 16,6 % tous niveaux réunis.
- Le service **ne distingue pas** une zone hors territoire d'une zone pas encore
  livrée : il répond 200 avec une liste vide dans les deux cas.
- La Géoplateforme plafonne à une dizaine de requêtes simultanées et rejette
  tout d'un coup au-delà ; la file d'attente est bornée à 4 avec reprise.

## Données et licences

- **LiDAR HD, Plan IGN, index des dalles** : © IGN — Géoplateforme, sous
  [Licence Ouverte Etalab 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/).
- L'organisation en styles nommés vient de
  [prettymaps](https://github.com/marceloprates/prettymaps) et de
  [prettymapp](https://github.com/chrieke/prettymapp). Aucun code ni aucune
  couleur n'en est repris : les nuanciers décoratifs ont été retirés lors du
  recentrage sur l'analyse.

## Stack

Vite, JavaScript sans framework, Three.js pour le rendu, laz-perf (WASM) pour le
décodage LAZ dans un Web Worker, Leaflet et proj4 pour la carte et le Lambert-93.
