# Explorateur LiDAR HD

Explorer, mesurer et contrôler le nuage de points LiDAR HD de l'IGN
directement dans le navigateur.

Les dalles sont diffusées au format **COPC**, le serveur de la Géoplateforme
honore les requêtes `Range` et renvoie `access-control-allow-origin: *` : la page
lit donc les données **directement chez l'IGN**, sans backend ni copie locale.
L'octree du format fournit le niveau de détail — deux requêtes et 46 Ko donnent
la structure d'une dalle de 171 Mo.

## Lancer

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
   le détail se raffine ensuite selon l'endroit où vous regardez, et les dalles
   voisines viennent d'elles-mêmes quand vous vous déplacez — une case permet de
   s'en tenir à la dalle choisie.
3. **Naviguer**, puis choisir un preset ou une source de couleur selon ce que
   vous cherchez à voir.

### Se déplacer dans la scène

| geste | effet |
|---|---|
| clic gauche + glisser | faire tourner la vue autour du point visé |
| clic droit + glisser | déplacer la vue latéralement |
| molette | avancer et reculer |
| clic gauche **sans bouger** | poser un point, en mode mesure |
| `Échap` | quitter le mode mesure |

Le même bouton gauche fait tourner la vue et pose un point de mesure : seul un
clic immobile pose un point, un glissement tourne toujours la caméra. La
tolérance est de cinq pixels, personne ne cliquant parfaitement immobile.

Quitter le mode mesure **n'efface pas** la mesure — on en sort justement pour
tourner autour sans risquer de poser un point de plus. Les marqueurs gardent
leur taille apparente quand on se déplace, et l'effacement est un geste
explicite.

Une barre en haut de la vue dit où en est le chargement, en points chargés
rapportés aux points voulus. Elle disparaît une fois à jour : un indicateur qui
ne bouge plus n'informe plus.

### Deux réglages qui changent tout

- **Seuil de détail** — c'est le vrai levier de précision. L'abaisser fait
  descendre plus bas dans l'octree : de 3 px à 0,8 px, le nombre de points
  triple. En dessous, c'est le plafond de points qui limite, pas le seuil.
- **Taille des points** — la référence 1 vaut l'espacement du niveau affiché :
  deux points voisins s'y touchent tout juste. Au-delà on gagne une surface
  pleine en perdant du détail, ce qui va contre l'intérêt de la donnée.

Ces réglages, comme les filtres de classe, sont conservés quand on change de
preset : comparer deux rendus ne doit pas obliger à tout régler de nouveau.

## Ce que ça fait

- **Sélection par la carte** — index des dalles via le WFS public de la
  Géoplateforme, fond Plan IGN, métadonnées d'acquisition affichées (dates,
  capteur, procédé de classement).
- **Niveau de détail piloté par la caméra**, plafonné en nombre de points, avec
  éviction des nœuds hors champ.
- **Dalles voisines chargées au déplacement**, neuf au plus, les plus lointaines
  relâchées. L'option se décoche pour s'en tenir à la dalle choisie sur la
  carte : moins de requêtes sur un service qui plafonne à une dizaine
  simultanées, une emprise qui ne bouge plus sous une mesure ou un export, et
  tout le budget de points pour ce kilomètre carré. La décocher relâche aussi
  les voisines déjà chargées — un réglage qui ne défait pas ce qu'il avait fait
  donne l'impression de ne rien faire.
- **Filtres de classe** instantanés : la classification vit sur le GPU, un octet
  par point indexant une palette.
- **Mesure dans la scène** — deux clics donnent distance 3D, distance
  horizontale, dénivelé, pente en pourcentage *et* en degrés, azimut, et les
  altitudes en NGF-IGN69. La mesure survit à la navigation. Le point sous le curseur est retrouvé en lisant le
  tampon de profondeur, ce qui coûte le même prix quel que soit le nombre de
  points et rend exactement ce que l'œil voit.
- **Export d'image** jusqu'à quatre fois la résolution de l'écran. Les rayons
  d'ombrage, exprimés en texels, sont mis à l'échelle du facteur d'export :
  sans cela l'image produite ne ressemblerait pas à ce qu'on voyait.
- **Les rasters dérivés de l'IGN**, demandés au service WMS sur l'emprise
  chargée, en float32 brut (`image/x-bil;bits=32`) : 4 Mo pour 3 km en 1024
  cellules, soit une maille de 2,9 m sans aucun trou. Le format évite d'ajouter
  un décodeur GeoTIFF. Chacun n'est demandé que par le mode qui s'en sert.

  | raster | ce qu'il apporte |
  |---|---|
  | `MNT` | le sol. Il remplace le terrain qu'on reconstruisait depuis les seuls points classés sol, qui avait des trous sous le couvert |
  | `MNH` | la hauteur au-dessus du sol sur **toute** l'emprise, quel que soit le niveau de détail chargé : c'est la référence contre laquelle se juge la statistique tirée des points affichés |

  Quand un raster n'est pas publié sur la zone, le panneau le dit ; pour le MNT,
  le terrain reconstruit depuis les points de sol prend le relais.

- **Coloration au choix** — par classe, par **intensité** (réflectance, bornée
  automatiquement sur les centiles de la zone chargée), par **nombre de retours**
  (un tir multi-écho a traversé du feuillage), par **bande de vol** (les passes
  de l'avion se recouvrent, ce qui explique une densité trois fois supérieure à
  celle annoncée), ou par hauteur au-dessus du sol.
- **Trois presets d'affichage**, qui règlent d'un clic nuancier, fond, source
  de couleur et relief :

  | preset | à quoi il sert |
  |---|---|
  | `lecture` | nuancier de classification sur fond sombre, sans post-traitement — la vue de référence |
  | `relief` | nuancier neutre et ombrage appuyé : c'est la vue qui donne le plus à lire sur la structure du bâti |
  | `canopée` | couleur par hauteur au-dessus du sol, du sol nu aux émergents, avec les statistiques de canopée |

  Ils ne fixent ni la taille ni la forme des points, ni le seuil de détail : ce
  sont des préférences d'affichage, conservées d'un preset à l'autre pour qu'on
  puisse comparer deux rendus sans les régler de nouveau.

  L'éclairage de profondeur et l'ombrage directionnel rendent le relief lisible
  sur un nuage qui, faute de normales, paraîtrait plat. C'est le seul
  post-traitement conservé : tout ce qui relevait du rendu décoratif a été
  retiré.

## Points de vigilance

- La **saison d'acquisition** change tout à la végétation : un relevé feuilles
  tombées ne montre pas la même canopée qu'un relevé de juin. La date figure
  dans le panneau.
- Les altitudes sont **orthométriques** (NGF-IGN69), pas ellipsoïdales : les
  comparer à un relevé GNSS brut demande une conversion de géoïde, de l'ordre de
  45 à 50 m en France.
- Le MNT officiel est **plus complet, pas plus juste** : là où la grille
  calculée avait vu le sol, les deux s'accordent à 19 cm près (p90). Son apport
  est ailleurs — 100 % de couverture contre 39 à 46 % de cellules réellement
  observées, donc plus rien d'inventé par diffusion, et un terrain complet dès
  l'ouverture de la dalle au lieu de s'améliorer à mesure que les points
  arrivent.
- Les rasters sont lus à **2,9 m alors qu'ils sont produits à 50 cm** : le sol,
  lisse, n'y perd rien, la végétation presque rien — le MNH y perd 0,2 m au
  centile 99 et 1 m sur son maximum. Une surface à arêtes vives, elle, y perdrait
  beaucoup plus.
- Le service assortit ses **réponses d'erreur** d'un `Cache-Control` de
  **vingt et un jours**. Une panne d'une seconde reste donc figée trois semaines
  dans le cache du navigateur, et redemander la même URL ne fait que relire
  l'erreur : la reprise force la revalidation.
- Les **parts de classes affichées** portent sur les points chargés, pas sur la
  composition du terrain. Mesuré sur emprise identique, la végétation haute pèse
  24,3 % au niveau 2 de l'octree contre 16,6 % tous niveaux réunis.
- Le service **ne distingue pas** une zone hors territoire d'une zone pas encore
  livrée : il répond 200 avec une liste vide dans les deux cas.
- La Géoplateforme plafonne à une dizaine de requêtes simultanées et rejette
  tout d'un coup au-delà ; la file d'attente est bornée à 4 avec reprise.

## Vérifications

La suite de tests couvre les modules purs — décodage COPC, sélection de niveau
de détail, projection, modèles de terrain, déclaration des sources, mesures.
Elle est **éprouvée
par mutation** : des défauts sont injectés un par un pour vérifier qu'elle les
attrape, et plusieurs trous ont été trouvés ainsi, dont un test qui vérifiait sa
propre convention au lieu de celle de la bibliothèque.

Ce que les tests ne couvrent pas — le rendu, l'éviction GPU, le multi-dalles —
dépend de WebGL et se vérifie dans le navigateur, en mutant dans les deux sens :
un contrôle qui ne peut pas échouer ne prouve rien.

Le calage du MNT est contrôlé contre les points eux-mêmes : sur 35 434 points
classés sol de la dalle de Toulouse, l'écart au raster a une médiane de −3,1 cm
et 91 % restent sous 20 cm. Le témoin — la même lecture sur une grille
volontairement retournée nord/sud — tombe à 7,3 % sous 20 cm : la mesure
distingue donc bien un terrain calé d'un terrain qui ne l'est pas.

Les rasters ont été contrôlés l'un par l'autre, MNS compris : sur nos propres
grilles, `MNS − MNT − MNH` a une médiane nulle, des centiles à ±0,28 m et 0,15 %
de cellules au-delà du mètre. Le MNS n'est plus demandé par la page — il ne
servait qu'à l'audit de classification, retiré depuis — et la déclaration des
sources ne le mentionne donc pas : une source déclarée mais jamais interrogée
est une déclaration fausse.

La déclaration des sources est elle-même sous contrôle. Elle ne recopie aucune
adresse : elle lit les constantes que le code appelle, et les tests vérifient
que toute couche interrogée y figure, qu'aucune n'y figure en trop, que chaque
dépendance du `package.json` y est déclarée avec sa licence, et que les numéros
de version viennent du fichier plutôt que d'une saisie.

## Données et licences

La page les déclare elle-même, sous **Sources et licences** — un bloc replié par
défaut, la liste complète occupant plus de place que le reste du panneau. La
mention courte reste visible en permanence sur la carte. Ce n'est pas une liste
tenue à la main : elle est construite à partir des constantes que le code appelle
réellement, et des dépendances du `package.json`. Une déclaration recopiée à côté
du code cesse d'être vraie au premier changement, sans erreur ni diff — et une
mention de source fausse est pire que pas de mention du tout.

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

Logiciels embarqués : **Three.js** (MIT) pour le rendu, **laz-perf** (Apache-2.0)
pour le décodage LAZ en WebAssembly dans un Web Worker, **Leaflet** (BSD-2-Clause)
pour la carte, **proj4** (MIT) pour le Lambert-93. Le tout construit avec Vite,
en JavaScript sans framework.

L'organisation en styles nommés vient de
[prettymaps](https://github.com/marceloprates/prettymaps) et de
[prettymapp](https://github.com/chrieke/prettymapp). Aucun code ni aucune
couleur n'en est repris : les nuanciers décoratifs ont été retirés lors du
recentrage sur l'analyse.
