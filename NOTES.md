# Notes de mesure

Ce que le [README](README.md) résume, mesuré. Chaque chiffre vient d'un relevé
fait dans le navigateur, pas d'une estimation ; les protocoles sont indiqués
pour qu'ils puissent être refaits ou contredits.

Sauf mention contraire, le terrain d'essai est la dalle `LHD_FXX_0574_6280`
(Toulouse) : 171 Mo, 47,9 M points, 31 pts/m² — et non les 10 annoncés, les
passes de l'avion se recouvrant.

## Ce que coûte le format

Deux requêtes et 46 Ko donnent la structure d'une dalle de 171 Mo. Première
image en **0,87 s cache vidé**, pour 3 requêtes et 0,77 Mo. Le décodage laz-perf
tourne à environ 1,8 M pts/s dans un Web Worker.

Repères de sélection : vue d'ensemble 2 nœuds / 214 k points ; vue rapprochée
47 nœuds / 3,56 M points.

## Le niveau de détail biaise la composition

Les niveaux de l'octree sont disjoints, et ils ne contiennent pas les mêmes
classes. Mesuré sur emprise identique — un nœud de niveau 2 et ses 131
descendants, 3 843 843 points :

| classe | niv 2 | niv 3 | niv 4 | niv 5 | cumul |
|---|---|---|---|---|---|
| bâtiment | 47,4 | 47,8 | 50,0 | 61,6 | **56,1** |
| végétation haute | 24,3 | 23,4 | 20,4 | 12,8 | **16,6** |
| sol | 12,8 | 15,0 | 19,4 | 20,0 | **19,0** |
| non classé | 14,6 | 12,8 | 9,5 | 5,3 | **7,7** |

La végétation haute est sur-représentée d'un **facteur 1,46** aux niveaux
grossiers, et le niveau 5 seul se trompe en sens inverse. Seul le cumul complet
décrit le terrain : une part de classe calculée sur un sous-ensemble de niveaux
décrit l'affichage, pas la zone.

## Terrain : le MNT officiel contre la grille calculée

Le terrain venait d'abord des seuls points classés sol, trous comblés par
diffusion. Il vient maintenant du **MNT publié par l'IGN**, dérivé de la
totalité des points.

**Calage, contrôlé contre les points eux-mêmes.** Sur 35 434 points classés sol,
l'écart au raster a une médiane de **−3,1 cm**, et 91 % restent sous 20 cm. Le
témoin — la même lecture sur une grille volontairement retournée nord/sud —
tombe à 7,3 % sous 20 cm : la mesure distingue bien un terrain calé d'un terrain
qui ne l'est pas.

**Ce que la substitution apporte.** Couverture 100 % contre 39 à 46 % de
cellules réellement observées ; maille 2,9 m contre 5,9 m ; terrain complet dès
l'ouverture au lieu de s'améliorer avec les points. Elle n'apporte **pas** de
justesse : là où la grille calculée voyait le sol, les deux s'accordent à 19 cm
près (p90), et les statistiques de canopée ne bougent pas — cimes à 12,6 m dans
les Landes, identiques des deux côtés.

**Cohérence des trois rasters.** Sur nos propres grilles, `MNS − MNT − MNH` a une
médiane nulle, des centiles à ±0,28 m et 0,15 % de cellules au-delà du mètre. Le
MNS n'est plus demandé par la page : il ne servait qu'à un audit de
classification retiré depuis, et une source déclarée mais jamais interrogée est
une déclaration fausse.

**Résolution de lecture.** Les rasters sont produits au pas de 50 cm et lus à
2,9 m. Le sol, lisse, n'y perd rien ; le MNH y perd 0,2 m au centile 99 et 1 m
sur son maximum. Une surface à arêtes vives y perdrait beaucoup plus — mesuré
sur le MNS avant son retrait, la part de points le dépassant de 2 m passait de
7,6 % à 50 cm à 15,8 % à 2,9 m.

**Le MNH comme référence de canopée.** Il décrit toute l'emprise au même pas,
quel que soit le niveau chargé. Sur Toulouse, les cimes concordent — 27,9 m au
raster contre 28,2 m aux points — mais le maximum passe de 42,0 m aux points à
31,2 m au raster : c'est ce que vaut un maximum tiré d'un seul point.

## Rendu aux réglages extrêmes

Canevas 900 × 600, une seule dalle, caméra fixe. La part de trous est celle des
pixels de fond restés à l'intérieur de la silhouette du nuage :

| taille des points | seuil de détail | points | nœuds | trous |
|---|---|---|---|---|
| 1,0 | 1,5 | 1 082 449 | 9 | **1,01 %** |
| 0,4 | 1,5 | 1 082 449 | 9 | **9,59 %** |
| 1,0 | 0,5 | 3 991 352 | 40 | **0,98 %** |
| 0,4 | 0,5 | 3 991 352 | 40 | **3,66 %** |

**Au seuil minimal, c'est le plafond de points qui décide, plus le seuil.**
3 991 352 points sur 4 000 000, et 14 nœuds écartés faute de place. La coupe
reste propre : les écartés ont une erreur écran de 0,50 à 0,59 px, les retenus
de 0,61 à 15,47 — aucune inversion de priorité, donc pas de plaque grossière au
milieu du fin. Un contrôle l'annonce désormais, parce qu'un plafond respecté ne
dit pas qu'il ne gêne pas.

**À la taille minimale, le réglage n'agit plus que sur la sous-couche.** Un point
ne peut pas être rasterisé sous un pixel : aux deux minimums, 98 % des nœuds
calculent une taille inférieure à 1 px et sont ramenés à ce plancher. Ne
grandissent plus que les nœuds grossiers — ceux qui bouchent les interstices
entre les points fins. Réduire la taille n'amincit donc pas le détail, elle
retire la sous-couche.

**Pas de battement au ras du plafond** : 0 éviction et 0 requête sur 2 556 images
caméra immobile, contre 13 et 13 dès qu'elle bouge. **La visée ne perd rien** :
36,7 % de touches aux deux minimums contre 37,5 % au réglage courant, sur la
même grille de 240 points.

**Le grossissement des points ne sert plus.** Il avait été retenu du temps où
les points laissaient voir le fond entre eux ; mesure faite, il ne gagnait plus
que 0,18 point de pourcentage de trous, et effaçait la résolution qu'on est allé
chercher dans la donnée. Le vrai levier de précision est le seuil de détail : de
3 px à 0,8 px, le nombre de points triple.

## Filtres et coupe

**Filtre de hauteur.** L'invariant qui compte est la complémentarité : deux
plages qui se rejoignent peignent exactement ce que peint l'absence de filtre —
207 916 pixels des deux côtés, aucun manquant, aucun en trop. Le témoin montre
que la mesure discrimine : déplacer la borne de 20 à 15 m retire 8 299 pixels.

**Coupe.** Le shader masque la bande, le parcours CPU l'échantillonne, et les
deux lisent la même géométrie. Les comptes croissent ensemble et quasi
linéairement avec la largeur : 1 569 points et 1 052 pixels à 2 m, 72 895 et
6 719 à 80 m.

**Profil.** La ligne de sol officielle doit passer sous les points de la coupe.
Sur 60 cases, le point le plus bas de chaque case est à **−13 cm** du sol en
médiane, et deux cases seulement descendent de plus de 50 cm — l'écart attendu
entre des points individuels et un terrain lu à 2,9 m.

## Incertitude d'une mesure

Deux termes s'ajoutent, et le second domine souvent :

1. l'exactitude annoncée par le producteur — 50 cm en planimétrie, 10 cm en
   altimétrie ;
2. l'**échantillonnage** : on ne vise pas un objet, on vise le point affiché le
   plus proche, et l'arête réelle peut se trouver jusqu'à la moitié de
   l'espacement à côté.

À 3 m d'espacement, le second pèse trois fois le premier. Ils sont indépendants,
d'où la somme quadratique ; une distance cumule ses deux extrémités, d'où le
facteur √2. L'espacement retenu est celui du niveau réellement affiché à
l'endroit visé, et il se resserre quand on s'approche.

## Pièges rencontrés

Ceux qui ont coûté du temps, et qu'aucun message d'erreur n'annonçait.

- **L'en-tête LAS range le maximum avant le minimum** pour chaque axe. Une
  lecture naïve donne une emprise de « −1000 × −1000 m » sans broncher.
- **`pointCount === -1`** dans la hiérarchie COPC désigne une page enfant, pas un
  nœud vide.
- **Le nœud racine de toute dalle s'appelle `0-0-0-0`** : sans identifiant
  préfixé par la dalle, la deuxième chargée passe pour déjà présente.
- **Chaque dalle est centrée sur son propre octree.** Réunies telles quelles,
  elles se superposent toutes sur le même kilomètre carré : la scène doit avoir
  une origine unique, que le décodeur soustrait — et le plafond de points doit
  être commun, sans quoi il laisse passer N fois le budget.
- **Le Lambert-93 ne survit pas à un Float32**, qui n'y offre qu'un pas de
  50 cm. Il faut recentrer *avant* la conversion, pas après.
- **La croissance du tas WASM détache les `ArrayBuffer`** déjà passés au worker.
  Pré-allouer et garder un `byteLength === 0` en garde.
- **Le raster officiel arrive en NGF absolu** alors que la scène a soustrait
  l'origine de sa dalle : l'écart valait exactement −632,36 m, sans qu'aucune
  exception ne le signale. La sentinelle d'absence, elle, ne se translate pas.
- **Le WMS assortit ses réponses d'erreur d'un `Cache-Control` de vingt et un
  jours.** Une panne d'une seconde reste donc figée trois semaines dans le cache
  du navigateur, et redemander la même URL ne fait que relire l'erreur : la
  reprise force la revalidation.
- **La Géoplateforme plafonne à une dizaine de requêtes simultanées** et rejette
  tout d'un coup au-delà, sans `Retry-After`. La file est bornée à 4 avec
  reprise exponentielle.
- **Le nom de dalle du WFS porte `_PTS_C_` là où l'URL porte `_PTS_`** :
  reconstruire l'URL depuis le nom donne un 404. Le `nombre_points` annoncé
  diffère aussi du fichier — inutilisable comme contrôle.
- **Three range le poids fort de `packDepthToRGBA` dans le rouge**, à l'inverse
  de la convention qu'on trouve encore partout. L'ordre inverse décode sans
  erreur une valeur entièrement fausse : 0,003 au lieu de 0,999, soit un point à
  20 cm de la caméra au lieu de 400 m.
- **`new THREE.Color(hex).r` rend du linéaire**, pas `hex / 255`.
- **Un `if (obj.champ)` dont le champ a disparu de la configuration** devient
  faux pour toujours : deux panneaux ont cessé de s'afficher pendant deux
  commits, sans erreur et sans rien dans le diff.
- **`formatLength` suppose une valeur déjà ronde** ; pour une distance
  quelconque c'est `formatDistance`. Les deux noms se ressemblent, et l'un avait
  déjà été renommé pour cette raison.
