import { defineConfig } from 'vite';

/**
 * Chemin de base du site.
 *
 * Sans ce reglage, le build reference ses ressources en chemin absolu
 * (`/assets/...`), ce qui marche a la racine d'un domaine et nulle part
 * ailleurs. Servi depuis un sous-chemin — `/lidar-explorer/` par exemple — la
 * page se charge et reste blanche, sans rien dans la console qui designe la
 * cause. Le defaut est latent tant qu'on sert a la racine, et il ne se
 * manifeste qu'a la premiere mise en ligne.
 *
 * La valeur vient de l'environnement pour que le developpement et un
 * hebergement a la racine restent a `/`. Sous Git Bash, `BASE_PATH` doit etre
 * protege par `MSYS_NO_PATHCONV=1`, faute de quoi le shell le convertit en
 * chemin Windows et le build sort des URL absurdes.
 */
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
});
