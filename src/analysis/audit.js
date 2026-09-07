/**
 * Contrôles de cohérence de la classification.
 *
 * La classification du LiDAR HD est automatique (`IGN_AUTO_V5`) et elle se
 * trompe. Sans vérité terrain, on ne peut en général qu'écrire « suspect » —
 * mais certaines contradictions se jugent sans avis extérieur, parce qu'elles
 * opposent la donnée soit à la physique, soit à la définition même des classes.
 * Ce sont celles-là qu'on mesure ici, et c'est pourquoi chaque contrôle porte
 * sa justification plutôt qu'un seuil tombé du ciel.
 */

/**
 * Bornes de hauteur des strates de végétation, en mètres au-dessus du sol.
 * Ce sont celles de la nomenclature du produit : basse 0–0,5, moyenne 0,5–1,5,
 * haute au-delà. Un point classé « végétation haute » posé au sol contredit
 * donc la définition de sa propre classe.
 */
export const VEGETATION_STRATA = {
  3: { min: 0, max: 0.5, label: 'végétation basse' },
  4: { min: 0.5, max: 1.5, label: 'végétation moyenne' },
  5: { min: 1.5, max: Infinity, label: 'végétation haute' },
};

/** Tolérances, volontairement larges : on cherche des fautes, pas des limites. */
export const TOLERANCES = {
  /** Marge sous la borne basse d'une strate avant de la déclarer contredite. */
  strate: 0.5,
  /** Un point de bâtiment sous le terrain de plus que cela est incohérent. */
  batimentSousSol: 1.0,
  /** Étendue verticale admise pour l'eau à l'intérieur d'une cellule. */
  eauEtendue: 0.5,
  /** Nombre de points d'eau sous lequel une cellule ne prouve rien. */
  eauMinPoints: 12,
};

/**
 * Contradictions ponctuelles : un point contre la définition de sa classe.
 *
 * Ne sont comptés que les points dont le sol est connu. Là où le terrain est
 * seulement interpolé, la hauteur est déjà une estimation et lui reprocher une
 * contradiction n'aurait pas de sens.
 */
export function classContradictions(grid, positions, classification, into = null) {
  const bilan = into ?? {
    vegetationTropBasse: 0,
    batimentSousSol: 0,
    solEnLair: 0,
    testes: 0,
    sansSol: 0,
  };

  for (let n = 0; n < classification.length; n += 1) {
    const code = classification[n];
    const strate = VEGETATION_STRATA[code];
    const estBati = code === 6;
    if (!strate && !estBati) continue;

    const x = positions[n * 3];
    const y = positions[n * 3 + 1];
    const h = grid.aboveGround(x, y, positions[n * 3 + 2]);
    if (Number.isNaN(h)) {
      bilan.sansSol += 1;
      continue;
    }
    bilan.testes += 1;

    if (strate && Number.isFinite(strate.min) && h < strate.min - TOLERANCES.strate) {
      bilan.vegetationTropBasse += 1;
    }
    if (estBati && h < -TOLERANCES.batimentSousSol) {
      bilan.batimentSousSol += 1;
    }
  }
  return bilan;
}

/**
 * Familles de classes, pour lire le dépassement de surface autrement qu'en un
 * chiffre global. L'ordre est celui de l'affichage.
 */
export const FAMILLES_SURFACE = [
  { cle: 'sol', libelle: 'sol et eau', codes: [2, 9] },
  { cle: 'vegetation', libelle: 'végétation', codes: [3, 4, 5] },
  { cle: 'bati', libelle: 'bâti', codes: [6] },
  { cle: 'pont', libelle: 'pont', codes: [17] },
  { cle: 'sursol', libelle: 'sursol pérenne', codes: [64] },
  { cle: 'nonClasse', libelle: 'non classés', codes: [1] },
  { cle: 'bruit', libelle: 'bruit', codes: [7, 18] },
];

const FAMILLE_PAR_CODE = new Map(
  FAMILLES_SURFACE.flatMap((f) => f.codes.map((c) => [c, f.cle])),
);

/** Marge au-dessus du MNS avant de compter un point comme dépassant. */
export const MARGE_SURFACE = 2;

function familleVide() {
  return { testes: 0, dessus: 0, ecartMax: 0 };
}

/**
 * Points qui dépassent la surface officielle, ventilés par famille de classes.
 *
 * Le MNS est une **grille** : il ne peut pas tenir un câble, une branche, un
 * garde-corps ni une antenne. Un point au-dessus n'est donc pas une faute en
 * soi — c'est ce que le raster ne sait pas représenter. Compter les
 * dépassements sans les ventiler ne dirait rien.
 *
 * Ce qui parle, c'est la comparaison entre familles. Mesuré sur une dalle de
 * Toulouse, à 2,9 m de maille :
 *
 * | famille | au-dessus de 2 m |
 * |---|---|
 * | sol et eau | 0,06 % / 0,00 % |
 * | végétation basse et moyenne | 0,03 % / 0,18 % |
 * | pont | 7,4 % |
 * | végétation haute | 16,3 % |
 * | bâti | 18,1 % |
 * | non classés | 23,5 % |
 * | sursol pérenne | 97,9 % |
 *
 * Le sol et l'eau forment le **témoin** : ils ne dépassent jamais une surface
 * correctement calée, et un chiffre non nul là dénoncerait le recalage bien
 * avant de dénoncer la donnée. À l'autre bout, le sursol pérenne — pylônes,
 * mâts, grues — dépasse presque toujours, parce que l'IGN l'écarte justement de
 * son MNS. Entre les deux, la part des points non classés dit ce que la
 * classification a laissé de côté.
 *
 * Attention à la résolution : lu à 2,9 m au lieu des 50 cm natifs, le
 * dépassement double environ (mesuré 15,8 % contre 7,6 % sur une même emprise).
 * Le chiffre décrit donc la lecture faite, pas la surface elle-même.
 */
export function surfaceExcess(mns, positions, classification, into = null, { marge = MARGE_SURFACE } = {}) {
  const bilan = into ?? {
    testes: 0,
    sansSurface: 0,
    dessus: 0,
    ecartMax: 0,
    marge,
    familles: Object.fromEntries(
      [...FAMILLES_SURFACE.map((f) => f.cle), 'autres'].map((cle) => [cle, familleVide()]),
    ),
  };

  for (let n = 0; n < classification.length; n += 1) {
    const surface = mns.heightAt(positions[n * 3], positions[n * 3 + 1]);
    if (Number.isNaN(surface)) {
      bilan.sansSurface += 1;
      continue;
    }
    bilan.testes += 1;
    const famille = bilan.familles[FAMILLE_PAR_CODE.get(classification[n]) ?? 'autres'];
    famille.testes += 1;

    const ecart = positions[n * 3 + 2] - surface;
    if (ecart <= marge) continue;
    bilan.dessus += 1;
    famille.dessus += 1;
    if (ecart > bilan.ecartMax) bilan.ecartMax = ecart;
    if (ecart > famille.ecartMax) famille.ecartMax = ecart;
  }
  return bilan;
}

/**
 * Planéité de l'eau.
 *
 * C'est le seul contrôle d'ici qui permette d'écrire « faux » plutôt que
 * « suspect » : une surface d'eau libre est horizontale. Sur une maille de
 * quelques dizaines de mètres, même un fleuve en pente ne descend que de
 * quelques centimètres. Une cellule dont les altitudes s'étalent sur un demi-
 * mètre ne contient donc pas que de l'eau — berge happée, reflet, écho parasite.
 */
export class WaterPlanarity {
  constructor({ cell = 20, code = 9 } = {}) {
    if (!(cell > 0)) throw new Error('cell doit être positif');
    this.cell = cell;
    this.code = code;
    this.cellules = new Map(); // clé -> { n, min, max }
  }

  addPoints(positions, classification) {
    let ajoutes = 0;
    for (let n = 0; n < classification.length; n += 1) {
      if (classification[n] !== this.code) continue;
      const i = Math.floor(positions[n * 3] / this.cell);
      const j = Math.floor(positions[n * 3 + 1] / this.cell);
      const z = positions[n * 3 + 2];
      const cle = `${i}:${j}`;
      const c = this.cellules.get(cle);
      if (c) {
        c.n += 1;
        if (z < c.min) c.min = z;
        if (z > c.max) c.max = z;
      } else {
        this.cellules.set(cle, { n: 1, min: z, max: z });
      }
      ajoutes += 1;
    }
    return ajoutes;
  }

  /** Cellules assez peuplées pour conclure, et part de celles qui échouent. */
  report() {
    let retenues = 0;
    let suspectes = 0;
    let pireEtendue = 0;
    let sommeEtendue = 0;
    for (const c of this.cellules.values()) {
      if (c.n < TOLERANCES.eauMinPoints) continue;
      retenues += 1;
      const etendue = c.max - c.min;
      sommeEtendue += etendue;
      if (etendue > pireEtendue) pireEtendue = etendue;
      if (etendue > TOLERANCES.eauEtendue) suspectes += 1;
    }
    return {
      cellules: this.cellules.size,
      retenues,
      suspectes,
      ratio: retenues > 0 ? suspectes / retenues : NaN,
      etendueMax: retenues > 0 ? pireEtendue : NaN,
      etendueMoyenne: retenues > 0 ? sommeEtendue / retenues : NaN,
      seuil: TOLERANCES.eauEtendue,
    };
  }
}

/**
 * Résumé lisible, avec la part que représente chaque anomalie.
 * Les valeurs absolues ne disent rien sans leur dénominateur : mille points
 * douteux sur dix millions, ce n'est pas la même chose que sur vingt mille.
 */
export function summarise(contradictions, eau) {
  const t = contradictions.testes || 1;
  return {
    testes: contradictions.testes,
    sansSol: contradictions.sansSol,
    vegetation: {
      count: contradictions.vegetationTropBasse,
      share: (100 * contradictions.vegetationTropBasse) / t,
    },
    batiment: {
      count: contradictions.batimentSousSol,
      share: (100 * contradictions.batimentSousSol) / t,
    },
    eau,
  };
}
