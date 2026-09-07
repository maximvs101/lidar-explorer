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
