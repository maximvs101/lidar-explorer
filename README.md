# Explorateur LiDAR HD

Explorer, mesurer et couper le nuage de points LiDAR HD de l'IGN, directement
dans le navigateur.

Les dalles sont diffusées au format **COPC**, le serveur de la Géoplateforme
honore les requêtes `Range` et renvoie `access-control-allow-origin: *` : la page
lit donc les données **directement chez l'IGN**, sans backend ni copie locale.
L'octree du format fournit le niveau de détail — deux requêtes et 46 Ko donnent
la structure d'une dalle de 171 Mo.

```bash
npm install
npm run dev      # http://localhost:5173
npm test
npm run build
```

## Prise en main

1. **Cliquer sur la carte** pour choisir un lieu. Les rectangles bleus montrent
   les dalles disponibles, à partir du zoom 12. Un endroit sans dalle publiée le
   dit explicitement plutôt que d'ouvrir une scène vide.
2. **« Charger le nuage »**. Le niveau grossier apparaît en moins d'une seconde,
   le détail se raffine selon l'endroit où vous regardez, et les dalles voisines
   viennent d'elles-mêmes — une case permet de s'en tenir à la dalle choisie.
3. **Naviguer**, puis choisir un preset ou une source de couleur.

| geste | effet |
|---|---|
| clic gauche + glisser | faire tourner la vue autour du point visé |
| clic droit + glisser | déplacer la vue latéralement |
| molette | avancer et reculer |
| clic gauche **sans bouger** | poser un point, en mode mesure |
| `Échap` | quitter le mode mesure |

Le même bouton gauche fait tourner la vue et pose un point : seul un clic
immobile en pose un, à cinq pixels de tolérance. Quitter le mode mesure n'efface
pas la mesure — on en sort justement pour tourner autour.

Le panneau ne montre que ce qui a un sens à l'instant où on le regarde : avant
chargement il tient en trois blocs, et les sections d'exploration — **Vue**,
**Chargement**, **Mesure**, **Image** — n'apparaissent qu'une fois un nuage en
scène.

## Ce que ça fait

- **Sélection par la carte**, index des dalles via le WFS public, métadonnées
  d'acquisition affichées : dates, capteur, procédé de classement.
- **Niveau de détail piloté par la caméra**, plafonné en nombre de points, avec
  éviction des nœuds hors champ et chargement des dalles voisines.
- **Cinq sources de couleur** — classe, intensité, nombre de retours, bande de
  vol, hauteur au-dessus du sol — et trois presets (`lecture`, `relief`,
  `canopée`) qui règlent d'un clic nuancier, fond et ombrage.
- **Filtres de classe** instantanés : la classification vit sur le GPU, un octet
  par point indexant une palette.
- **Filtre par hauteur au-dessus du sol**, pour isoler une strate — sol nu,
  sous-bois, émergents.
- **Mesure dans la scène** : distance 3D, distance horizontale, dénivelé, pente
  en pourcentage *et* en degrés, azimut, altitudes NGF-IGN69 — **et
  l'incertitude**, dominée par l'espacement du niveau affiché plutôt que par les
  50 cm de planimétrie annoncés par l'IGN.
- **Coupe et profil en travers** : une bande de largeur réglable le long du
  segment mesuré, et son tracé — distance en abscisse, altitude en ordonnée,
  points coloriés par classe, ligne de sol officielle par-dessus. L'étirement
  vertical y est annoncé, ce que presque aucun profil ne fait.
- **Empreinte de la vue sur la carte** : où l'on est, et de quel côté on regarde.
- **Export d'image** jusqu'à quatre fois la résolution de l'écran.
- **Terrain officiel de l'IGN** : le `MNT` sert de sol, le `MNH` de référence de
  canopée sur toute l'emprise. Demandés au WMS en float32 brut
  (`image/x-bil;bits=32`) — 4 Mo pour 3 km au pas de 2,9 m, sans décodeur
  GeoTIFF. Quand un raster manque sur la zone, le panneau le dit et le terrain
  reconstruit depuis les points de sol prend le relais.

## Lire les chiffres sans se tromper

- La **saison d'acquisition** change tout à la végétation : un relevé feuilles
  tombées ne montre pas la même canopée qu'un relevé de juin. La date est dans
  le panneau.
- Les altitudes sont **orthométriques** (NGF-IGN69), pas ellipsoïdales : les
  comparer à un relevé GNSS brut demande une conversion de géoïde, de l'ordre de
  45 à 50 m en France.
- Les **parts de classes** portent sur les points chargés, pas sur la
  composition du terrain : à emprise identique, la végétation haute pèse 24,3 %
  au niveau 2 de l'octree contre 16,6 % tous niveaux réunis.
- Le MNT officiel est **plus complet, pas plus juste** : là où la grille
  calculée voyait le sol, les deux s'accordent à 19 cm près (p90). Son apport
  est ailleurs — 100 % de couverture contre 39 à 46 % de cellules observées.
- **La mesure sert à inspecter, pas à arpenter** : on ne vise pas un objet, mais
  le point affiché le plus proche.
- Le service **ne distingue pas** une zone hors territoire d'une zone pas encore
  livrée : il répond 200 avec une liste vide dans les deux cas.

Le détail des mesures, des contrôles et des pièges est dans [NOTES.md](NOTES.md).

## Vérifications

Les modules purs — décodage COPC, sélection de niveau de détail, projection,
modèles de terrain, coupe, mesures, déclaration des sources — sont couverts par
des tests **éprouvés par mutation** : des défauts sont injectés un par un pour
vérifier que la suite les attrape. Plusieurs trous ont été trouvés ainsi, dont
un test qui vérifiait sa propre convention au lieu de celle de la bibliothèque.

Ce que les tests ne couvrent pas — le rendu, l'éviction GPU, le multi-dalles —
dépend de WebGL et se vérifie dans le navigateur, en mutant dans les deux sens :
un contrôle qui ne peut pas échouer ne prouve rien.

## Données et licences

Tout vient de l'**IGN — Géoplateforme**, sous
[Licence Ouverte / Open Licence 2.0 (Etalab)](https://www.etalab.gouv.fr/licence-ouverte-open-licence/),
et rien n'est réhébergé : le navigateur lit directement chez le producteur, sans
serveur intermédiaire ni clé d'accès.

| donnée | service | couches |
|---|---|---|
| nuages de points LiDAR HD | HTTP `Range` sur `data.geopf.fr/telechargement/` | — |
| index des dalles | WFS 2.0 `data.geopf.fr/wfs/ows` | `IGNF_NUAGES-DE-POINTS-LIDAR-HD:dalle` |
| modèles dérivés | WMS 1.3.0 `data.geopf.fr/wms-r/wms` | `IGNF_LIDAR-HD_{MNT,MNH}_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93` |
| fonds de carte | WMTS 1.0.0 `data.geopf.fr/wmts` | `GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2`, `ORTHOIMAGERY.ORTHOPHOTOS` |

La page déclare ces sources elle-même, sous **Sources et licences**. Ce n'est pas
une liste tenue à la main : elle est construite à partir des constantes que le
code appelle et des dépendances du `package.json`, et des tests vérifient qu'elle
ne dérive pas.

Logiciels embarqués : **Three.js** (MIT) pour le rendu, **laz-perf**
(Apache-2.0) pour le décodage LAZ en WebAssembly dans un Web Worker, **Leaflet**
(BSD-2-Clause) pour la carte, **proj4** (MIT) pour le Lambert-93. Construit avec
Vite, en JavaScript sans framework.

Le code de ce dépôt est sous [licence MIT](LICENSE). Les **données** n'en
relèvent pas : elles restent sous Licence Ouverte Etalab 2.0, et rien n'autorise
à les réhéberger sans en citer le producteur.
