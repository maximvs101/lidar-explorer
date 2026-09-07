/**
 * Modèle de terrain local, construit à partir des seuls points classés « sol ».
 *
 * Il sert à mesurer une hauteur au-dessus du sol : celle d'un arbre, d'un toit.
 * Le nuage donne des altitudes absolues, or ce qui intéresse est presque
 * toujours la hauteur relative — un arbre de 25 m reste un arbre de 25 m qu'il
 * pousse au bord du fleuve ou sur la colline.
 *
 * Le défaut de la méthode est connu et il faut le mesurer plutôt que le taire :
 * sous un couvert dense, le laser atteint mal le sol. Les cellules sans aucun
 * point de sol sont comblées par diffusion depuis leurs voisines, ce qui reste
 * une estimation. `coverage()` dit quelle part de la grille a été réellement
 * observée, et c'est cette part qui qualifie la confiance des hauteurs.
 */

/** Codes ASPRS considérés comme du sol. */
export const GROUND_CODES = new Set([2]);

export class TerrainGrid {
  /**
   * @param {object} options
   * @param {number[]} options.center  centre de la grille, en repère scène
   * @param {number} options.size      côté de la zone couverte, en mètres
   * @param {number} options.cells     nombre de cellules par côté
   */
  constructor({ center = [0, 0], size = 3000, cells = 512 } = {}) {
    if (!(size > 0)) throw new Error('size doit être positif');
    if (!Number.isInteger(cells) || cells < 2) throw new Error('cells doit être un entier >= 2');

    this.center = [center[0], center[1]];
    this.size = size;
    this.cells = cells;
    this.step = size / cells;
    this.minX = center[0] - size / 2;
    this.minY = center[1] - size / 2;

    this.sum = new Float64Array(cells * cells);
    this.count = new Uint32Array(cells * cells);
    this.height = new Float32Array(cells * cells);
    this.known = new Uint8Array(cells * cells);
    this.observed = 0;
    this.filled = false;
  }

  index(x, y) {
    const i = Math.floor((x - this.minX) / this.step);
    const j = Math.floor((y - this.minY) / this.step);
    if (i < 0 || i >= this.cells || j < 0 || j >= this.cells) return -1;
    return j * this.cells + i;
  }

  /**
   * Accumule les points de sol d'un lot décodé.
   *
   * On fait la moyenne par cellule plutôt que le minimum : le minimum s'accroche
   * au moindre point aberrant sous le sol, et il y en a toujours quelques-uns.
   */
  addPoints(positions, classification, ground = GROUND_CODES) {
    let added = 0;
    for (let n = 0; n < classification.length; n += 1) {
      if (!ground.has(classification[n])) continue;
      const k = this.index(positions[n * 3], positions[n * 3 + 1]);
      if (k < 0) continue;
      this.sum[k] += positions[n * 3 + 2];
      this.count[k] += 1;
      added += 1;
    }
    if (added > 0) this.filled = false;
    return added;
  }

  /** Part de la grille réellement observée, avant tout comblement. */
  coverage() {
    let n = 0;
    for (let k = 0; k < this.count.length; k += 1) if (this.count[k] > 0) n += 1;
    return n / this.count.length;
  }

  /**
   * Couverture restreinte à une zone.
   *
   * Sur la grille entière, le chiffre mêle deux choses sans rapport : les
   * endroits où le sol est masqué par la végétation, et ceux qui n'ont
   * simplement pas encore été chargés. Seul le premier dit quelque chose sur la
   * qualité de la mesure — d'où cette restriction à ce qu'on regarde.
   */
  coverageWithin(center, size) {
    const demi = size / 2;
    const i0 = Math.max(0, Math.floor((center[0] - demi - this.minX) / this.step));
    const i1 = Math.min(this.cells - 1, Math.floor((center[0] + demi - this.minX) / this.step));
    const j0 = Math.max(0, Math.floor((center[1] - demi - this.minY) / this.step));
    const j1 = Math.min(this.cells - 1, Math.floor((center[1] + demi - this.minY) / this.step));
    if (i1 < i0 || j1 < j0) return { observed: 0, total: 0, ratio: NaN };

    let observees = 0;
    let total = 0;
    for (let j = j0; j <= j1; j += 1) {
      for (let i = i0; i <= i1; i += 1) {
        total += 1;
        if (this.count[j * this.cells + i] > 0) observees += 1;
      }
    }
    return { observed: observees, total, ratio: total > 0 ? observees / total : NaN };
  }

  /**
   * Fige la grille : moyenne des cellules observées, puis comblement des trous
   * par diffusion depuis les voisines. Chaque passe n'étend le terrain connu que
   * d'une cellule, d'où le plafond de passes — au-delà, une zone sans aucun sol
   * alentour reste inconnue, et il vaut mieux le savoir que d'inventer.
   */
  build({ maxPasses = 64 } = {}) {
    const { cells } = this;
    this.observed = 0;
    for (let k = 0; k < this.count.length; k += 1) {
      if (this.count[k] > 0) {
        this.height[k] = this.sum[k] / this.count[k];
        this.known[k] = 1;
        this.observed += 1;
      } else {
        this.known[k] = 0;
      }
    }

    let restants = this.count.length - this.observed;
    let passes = 0;
    const suivant = new Float32Array(this.height);
    const nouveau = new Uint8Array(this.known);

    while (restants > 0 && passes < maxPasses) {
      let comble = 0;
      for (let j = 0; j < cells; j += 1) {
        for (let i = 0; i < cells; i += 1) {
          const k = j * cells + i;
          if (this.known[k]) continue;
          let somme = 0;
          let n = 0;
          for (let dj = -1; dj <= 1; dj += 1) {
            for (let di = -1; di <= 1; di += 1) {
              if (di === 0 && dj === 0) continue;
              const vi = i + di;
              const vj = j + dj;
              if (vi < 0 || vi >= cells || vj < 0 || vj >= cells) continue;
              const v = vj * cells + vi;
              if (!this.known[v]) continue;
              somme += this.height[v];
              n += 1;
            }
          }
          if (n > 0) {
            suivant[k] = somme / n;
            nouveau[k] = 1;
            comble += 1;
          }
        }
      }
      if (comble === 0) break; // plus rien à propager
      this.height.set(suivant);
      this.known.set(nouveau);
      restants -= comble;
      passes += 1;
    }

    this.filled = true;
    return { observed: this.observed, filled: this.count.length - restants, passes, restants };
  }

  /** Altitude du sol estimée en ce point, ou NaN hors zone connue. */
  heightAt(x, y) {
    const k = this.index(x, y);
    if (k < 0 || !this.known[k]) return NaN;
    return this.height[k];
  }

  /** Hauteur au-dessus du sol, ou NaN si le terrain y est inconnu. */
  aboveGround(x, y, z) {
    const sol = this.heightAt(x, y);
    return Number.isNaN(sol) ? NaN : z - sol;
  }
}

/**
 * Statistiques de hauteur d'un lot de points, restreintes à des classes.
 * Le maximum brut est trompeur — un seul point aberrant le fixe — d'où le
 * centile, qui décrit la canopée plutôt que son accident le plus haut.
 */
export function heightStats(grid, positions, classification, codes) {
  const hauteurs = [];
  let inconnus = 0;
  for (let n = 0; n < classification.length; n += 1) {
    if (!codes.has(classification[n])) continue;
    const h = grid.aboveGround(positions[n * 3], positions[n * 3 + 1], positions[n * 3 + 2]);
    if (Number.isNaN(h)) inconnus += 1;
    else hauteurs.push(h);
  }
  if (hauteurs.length === 0) return { count: 0, unknown: inconnus, max: NaN, p99: NaN, median: NaN };
  hauteurs.sort((a, b) => a - b);
  const at = (f) => hauteurs[Math.min(hauteurs.length - 1, Math.floor(f * hauteurs.length))];
  return {
    count: hauteurs.length,
    unknown: inconnus,
    max: hauteurs[hauteurs.length - 1],
    p99: at(0.99),
    median: at(0.5),
  };
}
