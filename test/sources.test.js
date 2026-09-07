import { describe, expect, it } from 'vitest';
import { DONNEES, LICENCE, LOGICIELS, echappe, renderSources } from '../src/ui/sources.js';
import { PRODUITS } from '../src/analysis/rasters.js';
import { WFS, WMS, WMTS } from '../src/geo/geoplateforme.js';
import paquet from '../package.json';

describe('déclaration des sources', () => {
  it('nomme chaque service que le code interroge vraiment', () => {
    // Une déclaration recopiée à côté du code cesse d'être vraie au premier
    // changement, sans erreur ni diff. Ce contrôle interdit la recopie : les
    // adresses déclarées doivent être les constantes elles-mêmes.
    const adresses = DONNEES.map((d) => d.adresse);
    expect(adresses).toContain(WFS.endpoint);
    expect(adresses).toContain(WMS.endpoint);
    expect(adresses).toContain(WMTS.endpoint);
  });

  it('déclare toutes les couches utilisées, et rien d’autre', () => {
    const couches = DONNEES.flatMap((d) => d.couches);
    const attendues = [
      WFS.layer, WMTS.plan, WMTS.ortho,
      ...Object.values(PRODUITS).map((p) => p.layer),
    ];
    expect(couches.sort()).toEqual(attendues.sort());
  });

  it('donne la licence et son producteur', () => {
    expect(LICENCE.nom).toMatch(/Etalab/);
    expect(LICENCE.producteur).toMatch(/IGN/);
    expect(LICENCE.url).toMatch(/^https:\/\//);
  });

  it('lit les versions dans le package.json plutôt que de les écrire', () => {
    // Une version écrite à la main annonce celle qu'on n'utilise plus dès la
    // mise à jour suivante.
    for (const l of LOGICIELS) {
      expect(l.version, `version de ${l.nom}`).toMatch(/^\d+\.\d+\.\d+/);
      expect(paquet.dependencies[l.paquet], `paquet de ${l.nom}`).toContain(l.version);
    }
  });

  it('couvre exactement les dépendances du projet', () => {
    // Ajouter une dépendance sans la déclarer fait échouer ce contrôle : c'est
    // le seul moment où quelqu'un y pensera.
    expect(LOGICIELS.map((l) => l.paquet).sort())
      .toEqual(Object.keys(paquet.dependencies).sort());
    for (const l of LOGICIELS) expect(l.licence, `licence de ${l.nom}`).toMatch(/\S/);
  });

  it('rend la déclaration dans le conteneur', () => {
    const el = { innerHTML: '' };
    renderSources(el);
    expect(el.innerHTML).toContain(LICENCE.nom);
    expect(el.innerHTML).toContain(WFS.layer);
    for (const p of Object.values(PRODUITS)) expect(el.innerHTML).toContain(p.layer);
  });

  it('échappe ce qu’elle insère dans la page', () => {
    // Ce qui est affiché vient de constantes du dépôt, donc rien d'hostile
    // aujourd'hui. Mais une fonction qui construit du HTML en faisant confiance
    // à sa source devient une injection le jour où la source change — et ce
    // jour-là, personne ne relira ce fichier.
    expect(echappe('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(echappe('a & b')).toBe('a &amp; b');
    expect(echappe('" onerror="x')).toBe('&quot; onerror=&quot;x');
    // L'esperluette passe en premier, sinon les entités s'échappent elles-mêmes.
    expect(echappe('&lt;')).toBe('&amp;lt;');
  });
});
