import { defineConfig } from 'vite';

/**
 * Chemin de base du site.
 *
 * Le build referencait ses ressources en chemin absolu (`/assets/...`), ce qui
 * marche a la racine d'un domaine et nulle part ailleurs. Un site de projet
 * GitHub Pages sert sous `/<depot>/` : sans ce reglage, la page se charge et
 * reste blanche, sans rien dans la console qui designe la cause.
 *
 * La valeur vient de l'environnement pour que le developpement et un
 * hebergement a la racine restent a `/`, et que seul le workflow de
 * publication ait a la changer.
 */
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
});
