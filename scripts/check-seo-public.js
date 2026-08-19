/*
  LITUM3D - Test de regresión: SEO técnico público (informe "auditoría/
  corrección de SEO técnico público") -- H1, canonical, hreflang ES/DE/FR +
  x-default, noindex en páginas transaccionales, copyright 2026.

  Fuente de verdad DINÁMICA (nunca una lista hardcodeada de páginas): este
  script parsea routes/index.js para obtener TODAS las rutas GET públicas
  reales y el fichero de views/ que sirve cada una. Si en el futuro se añade
  una página nueva a routes/index.js, este test la descubre automáticamente
  -- nunca hay que mantener una lista paralela a mano.

  Agrupación en "familias" (home/shop/about/...): se deriva del propio
  nombre de fichero quitando el sufijo -de.html/-fr.html/.html (p.ej.
  index.html/index-de.html/index-fr.html -> familia "index"), así que
  tampoco es una lista hardcodeada.

  Para cada fichero servido por una ruta GET real y con las 3 variantes de
  idioma (ES/DE/FR) registradas, se elige como "ruta canónica" la más corta
  de las rutas que sirven ese fichero -- esto descarta automáticamente alias
  como /tienda (shop.html también responde en /shop, más corta) sin
  necesidad de una lista de excepciones.

  Uso: node scripts/check-seo-public.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); checks++; }

const ROOT = path.join(__dirname, '..');
const VIEWS_DIR = path.join(ROOT, 'views');
const BASE = 'https://litum3d.com';

function readFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}
function readView(name) {
  return fs.readFileSync(path.join(VIEWS_DIR, name), 'utf8');
}

// =======================================================================
// 0) Fuente de verdad: parsear routes/index.js (nunca una lista a mano)
// =======================================================================
function getRoutesToFiles() {
  const src = readFile('routes/index.js');
  const re = /router\.get\('([^']+)',[\s\S]*?viewsDir,\s*'([^']+)'\)/g;
  const routeToFile = new Map();
  const fileToRoutes = new Map();
  let m;
  while ((m = re.exec(src))) {
    const [, route, file] = m;
    routeToFile.set(route, file);
    if (!fileToRoutes.has(file)) fileToRoutes.set(file, []);
    fileToRoutes.get(file).push(route);
  }
  return { routeToFile, fileToRoutes };
}

const { routeToFile, fileToRoutes } = getRoutesToFiles();
ok(routeToFile.size >= 30, `sanity: se descubrieron ${routeToFile.size} rutas GET reales en routes/index.js`);

// La ruta canónica de un fichero es la más corta de las que lo sirven
// (descarta alias como /tienda frente a /shop sin lista de excepciones).
function primaryRouteFor(file) {
  const routes = fileToRoutes.get(file) || [];
  return routes.slice().sort((a, b) => a.length - b.length)[0];
}

// =======================================================================
// Agrupar ficheros servidos por routes/index.js en familias ES/DE/FR
// =======================================================================
function familyAndLangOf(file) {
  if (file.endsWith('-de.html')) return { family: file.slice(0, -'-de.html'.length), lang: 'de' };
  if (file.endsWith('-fr.html')) return { family: file.slice(0, -'-fr.html'.length), lang: 'fr' };
  return { family: file.slice(0, -'.html'.length), lang: 'es' };
}

const families = new Map(); // family -> { es: file, de: file, fr: file }
for (const file of fileToRoutes.keys()) {
  const { family, lang } = familyAndLangOf(file);
  if (!families.has(family)) families.set(family, {});
  families.get(family)[lang] = file;
}

// Solo familias trilingües completas (ES+DE+FR) entran en las comprobaciones
// de hreflang recíproco -- si una familia no tiene los 3 idiomas, no se
// inventan enlaces hacia una traducción inexistente (instrucción explícita).
const trilingualFamilies = [...families.entries()].filter(([, langs]) => langs.es && langs.de && langs.fr);
ok(trilingualFamilies.length >= 12, `sanity: se descubrieron ${trilingualFamilies.length} familias trilingües ES/DE/FR reales`);

// =======================================================================
// 1) Exactamente un <h1> en cada página descubierta
// =======================================================================
function checkExactlyOneH1() {
  for (const file of fileToRoutes.keys()) {
    const html = readView(file);
    const h1Count = (html.match(/<h1[\s>]/g) || []).length;
    eq(h1Count, 1, `views/${file}: exactamente 1 <h1> (encontrados: ${h1Count})`);
  }
}

// =======================================================================
// 2) Canonical: presente, único, y apunta a la ruta pública real (más
//    corta) del propio fichero -- nunca a litum3d.es, nunca duplicado
// =======================================================================
function checkCanonical() {
  for (const file of fileToRoutes.keys()) {
    const html = readView(file);
    const matches = html.match(/<link rel="canonical" href="[^"]*"\s*\/?>/g) || [];
    eq(matches.length, 1, `views/${file}: exactamente un <link rel="canonical"> (encontrados: ${matches.length})`);
    if (matches.length === 1) {
      const expected = `${BASE}${primaryRouteFor(file)}`;
      ok(matches[0].includes(`href="${expected}"`), `views/${file}: canonical debe ser ${expected} (real: ${matches[0]})`);
      ok(!/litum3d\.es/i.test(matches[0]), `views/${file}: canonical no debe apuntar a litum3d.es`);
    }
  }
}

// =======================================================================
// 3) Hreflang: cluster recíproco ES/DE/FR + x-default (URLs absolutas,
//    reales, nunca hacia una traducción inexistente ni hacia /index-de,
//    /index-fr o litum3d.es)
// =======================================================================
function checkHreflang() {
  for (const [family, langs] of trilingualFamilies) {
    const expectedByLang = {
      es: `${BASE}${primaryRouteFor(langs.es)}`,
      de: `${BASE}${primaryRouteFor(langs.de)}`,
      fr: `${BASE}${primaryRouteFor(langs.fr)}`
    };

    for (const lang of ['es', 'de', 'fr']) {
      const file = langs[lang];
      const html = readView(file);
      const found = new Map(
        [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)]
          .map(m => [m[1], m[2]])
      );

      eq(found.size, 4, `views/${file} (familia ${family}): exactamente 4 enlaces hreflang (es/de/fr/x-default); encontrados ${found.size}`);
      eq(found.get('es'), expectedByLang.es, `views/${file}: hreflang="es" debe ser ${expectedByLang.es}`);
      eq(found.get('de'), expectedByLang.de, `views/${file}: hreflang="de" debe ser ${expectedByLang.de}`);
      eq(found.get('fr'), expectedByLang.fr, `views/${file}: hreflang="fr" debe ser ${expectedByLang.fr}`);
      eq(found.get('x-default'), expectedByLang.es, `views/${file}: hreflang="x-default" debe usar la versión ES principal (${expectedByLang.es})`);

      for (const href of found.values()) {
        ok(!/litum3d\.es/i.test(href), `views/${file}: ningún hreflang debe apuntar a litum3d.es`);
        ok(!/\/index-de|\/index-fr/.test(href), `views/${file}: ningún hreflang debe usar /index-de ni /index-fr (rutas inventadas)`);
        ok(href.startsWith(BASE), `views/${file}: hreflang href="${href}" debe ser absoluto sobre ${BASE}`);
      }
    }

    // Reciprocidad: ES/DE/FR deben coincidir exactamente en el mismo cluster.
    const [esFile, deFile, frFile] = [langs.es, langs.de, langs.fr];
    const extractSet = (file) => {
      const html = readView(file);
      return new Set([...html.matchAll(/<link rel="alternate" hreflang="[^"]+" href="([^"]+)">/g)].map(m => m[1]));
    };
    const esSet = extractSet(esFile), deSet = extractSet(deFile), frSet = extractSet(frFile);
    eq([...esSet].sort().join('|'), [...deSet].sort().join('|'), `familia ${family}: cluster hreflang de ${esFile} y ${deFile} debe ser idéntico (recíproco)`);
    eq([...esSet].sort().join('|'), [...frSet].sort().join('|'), `familia ${family}: cluster hreflang de ${esFile} y ${frFile} debe ser idéntico (recíproco)`);
  }
}

// =======================================================================
// 4) Legal ES/DE/FR correctamente agrupado (privacy/terms/cookies forman
//    parte de las familias trilingües con hreflang -- no un caso especial)
// =======================================================================
function checkLegalClusterGrouped() {
  const LEGAL = ['privacy-policy', 'terms-conditions', 'cookies-policy'];
  for (const key of LEGAL) {
    ok(trilingualFamilies.some(([family]) => family === key), `la familia legal "${key}" tiene cluster hreflang ES/DE/FR completo`);
  }
}

// =======================================================================
// 5) Páginas transaccionales: decisión de robots coherente
//    - cart/checkout/success -> noindex, follow
//    - privacy/terms/cookies -> noindex, follow (ya establecido, sin tocar)
//    - home/shop/about/contact/gallery/testimonios -> indexable (nunca
//      noindex en una página de contenido/comercial)
// =======================================================================
function checkRobotsDecisions() {
  const NOINDEX_FAMILIES = ['cart', 'checkout', 'success', 'privacy-policy', 'terms-conditions', 'cookies-policy'];
  const INDEXABLE_FAMILIES = ['index', 'shop', 'about', 'contact', 'gallery', 'testimonios'];

  for (const family of NOINDEX_FAMILIES) {
    const langs = families.get(family);
    ok(!!langs, `familia "${family}" existe`);
    for (const lang of ['es', 'de', 'fr']) {
      const html = readView(langs[lang]);
      const m = html.match(/<meta name="robots" content="([^"]*)">/);
      ok(!!m, `views/${langs[lang]}: tiene meta robots explícito`);
      ok(m && /noindex/.test(m[1]), `views/${langs[lang]}: debe ser noindex (página transaccional/legal, familia "${family}")`);
    }
  }

  for (const family of INDEXABLE_FAMILIES) {
    const langs = families.get(family);
    ok(!!langs, `familia "${family}" existe`);
    for (const lang of ['es', 'de', 'fr']) {
      const html = readView(langs[lang]);
      const m = html.match(/<meta name="robots" content="([^"]*)">/);
      ok(!m || !/noindex/.test(m[1]), `views/${langs[lang]}: página de contenido/comercial, NO debe ser noindex (familia "${family}")`);
    }
  }
}

// =======================================================================
// 6) Copyright 2026 (no 2025/2024 estático) en toda página descubierta
// =======================================================================
function checkCopyrightYear() {
  for (const file of fileToRoutes.keys()) {
    const html = readView(file);
    const m = html.match(/&copy;\s*(?:<span[^>]*>)?\s*(\d{4})/);
    ok(!!m, `views/${file}: tiene un año de copyright detectable`);
    if (m) eq(m[1], '2026', `views/${file}: copyright debe mostrar 2026 (real: ${m[1]})`);
  }
}

function main() {
  checkExactlyOneH1();
  checkCanonical();
  checkHreflang();
  checkLegalClusterGrouped();
  checkRobotsDecisions();
  checkCopyrightYear();

  console.log(`OK: ${checks} comprobaciones de SEO técnico público (H1/canonical/hreflang/noindex/copyright).`);
}

main();
