/*
  LITUM3D - Auditoría de i18n pública DE/FR (informe correspondiente).

  Sin BD real ni servidor HTTP real (mismo patrón que otros check-*.js de
  este repo): extrae los handlers REALES de routes/index.js/routes/productos.js
  del router de Express con un fake pool/res cuando hace falta, y hace
  comprobaciones de fuente sobre los ficheros de vista/JS reales -- nunca
  reimplementa la lógica que prueba.

  Cubre:
  1) El tooltip de WhatsApp de checkout-de/fr ya no queda en español
     (único texto residual real que encontró la auditoría completa de las
     18 vistas *-de.html/*-fr.html).
  2) TODOS los enlaces a la política de privacidad en *-de.html/*-fr.html
     apuntan a la variante localizada (/privacy-policy-de,
     /privacy-policy-fr), nunca a /privacy-policy (ES) -- descubiertos
     dinámicamente listando views/, no una lista de archivos hardcodeada.
  3) routes/index.js expone GET /privacy-policy-de y /privacy-policy-fr,
     sirviendo el fichero real correspondiente.
  4) views/privacy-policy-de.html y -fr.html existen, con la MISMA
     estructura (mismo número de secciones h2/h3) que la versión ES --
     traducción fiel, no reescritura.
  5) public/js/customization.js: el diccionario i18n mínimo centralizado
     (CUSTOMIZATION_I18N/t()) devuelve exactamente el mismo texto de
     siempre para 'es' (regresión: nunca cambia lo que ya funcionaba) y el
     texto traducido real para 'de'/'fr', usando el MISMO mecanismo de
     idioma que ya usan shop.js/home.js (document.documentElement.lang) --
     nunca tres copias del archivo.
  6) public/js/home.js ya pasa ?lang= a /api/productos, igual que
     shop.js -- regresión del bug que hacía que Home nunca mostrara
     nombre_de/nombre_fr aunque existieran en BD.
  7) routes/productos.js: productos con nombre_de/nombre_fr en BD se
     traducen con ?lang=de/fr; sin traducción en BD, cae a español (nunca
     se inventa contenido) -- fake pool con datos de fixture, nunca IDs de
     producto reales.
  8) ES no se rompe: view ES sigue enlazando a /privacy-policy (no a
     ninguna variante -de/-fr), y customization.js con lang='es' (o sin
     document.documentElement) sigue produciendo el texto español de siempre.

  Uso: node scripts/check-i18n-public.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); checks++; }

const VIEWS_DIR = path.join(__dirname, '..', 'views');
function readFile(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}
function readView(name) {
  return fs.readFileSync(path.join(VIEWS_DIR, name), 'utf8');
}
function listViews(suffixRegex) {
  return fs.readdirSync(VIEWS_DIR).filter(f => suffixRegex.test(f));
}

// =======================================================================
// 1) WhatsApp: sin residuo español en checkout-de/fr
// =======================================================================
function checkWhatsappTooltipLocalized() {
  const de = readView('checkout-de.html');
  const fr = readView('checkout-fr.html');
  ok(!/title="Contactar por WhatsApp"/.test(de), 'checkout-de.html: el tooltip de WhatsApp ya no está en español');
  ok(/title="Per WhatsApp kontaktieren"/.test(de), 'checkout-de.html: el tooltip de WhatsApp usa el mismo texto alemán que el resto de páginas DE');
  ok(!/title="Contactar por WhatsApp"/.test(fr), 'checkout-fr.html: el tooltip de WhatsApp ya no está en español');
  ok(/title="Contacter par WhatsApp"/.test(fr), 'checkout-fr.html: el tooltip de WhatsApp usa el mismo texto francés que el resto de páginas FR');
}

// =======================================================================
// 2) Enlaces de privacidad en TODAS las vistas DE/FR (descubiertas, no hardcodeadas)
// =======================================================================
function checkPrivacyLinksLocalizedEverywhere() {
  const deViews = listViews(/-de\.html$/).filter(f => f !== 'privacy-policy-de.html');
  const frViews = listViews(/-fr\.html$/).filter(f => f !== 'privacy-policy-fr.html');
  ok(deViews.length >= 9, `sanity: se descubrieron ${deViews.length} vistas *-de.html (esperaba al menos 9)`);
  ok(frViews.length >= 9, `sanity: se descubrieron ${frViews.length} vistas *-fr.html (esperaba al menos 9)`);

  for (const file of deViews) {
    const html = readView(file);
    if (!/privacy-policy/.test(html)) continue; // esta vista no enlaza a privacidad, no aplica
    ok(!/href="\/privacy-policy"/.test(html), `views/${file}: ningún enlace de privacidad apunta a la versión ES (/privacy-policy)`);
    ok(/href="\/privacy-policy-de"/.test(html), `views/${file}: el/los enlace(s) de privacidad apuntan a /privacy-policy-de`);
  }
  for (const file of frViews) {
    const html = readView(file);
    if (!/privacy-policy/.test(html)) continue;
    ok(!/href="\/privacy-policy"/.test(html), `views/${file}: ningún enlace de privacidad apunta a la versión ES (/privacy-policy)`);
    ok(/href="\/privacy-policy-fr"/.test(html), `views/${file}: el/los enlace(s) de privacidad apuntan a /privacy-policy-fr`);
  }
}

// =======================================================================
// 3) Rutas reales: GET /privacy-policy-de y /privacy-policy-fr
// =======================================================================
function getRouteHandler(router, method, routePath) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`Ruta no encontrada: ${method.toUpperCase()} ${routePath}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function checkPrivacyRoutesServeRealFiles() {
  const indexRouter = require('../routes/index');
  const deHandler = getRouteHandler(indexRouter, 'get', '/privacy-policy-de');
  const frHandler = getRouteHandler(indexRouter, 'get', '/privacy-policy-fr');

  let sentPath = null;
  const res = { sendFile: (p) => { sentPath = p; } };
  deHandler({}, res);
  ok(sentPath && sentPath.endsWith('privacy-policy-de.html'), 'GET /privacy-policy-de sirve views/privacy-policy-de.html');
  ok(fs.existsSync(sentPath), 'GET /privacy-policy-de: el fichero que sirve existe realmente en disco');

  sentPath = null;
  frHandler({}, res);
  ok(sentPath && sentPath.endsWith('privacy-policy-fr.html'), 'GET /privacy-policy-fr sirve views/privacy-policy-fr.html');
  ok(fs.existsSync(sentPath), 'GET /privacy-policy-fr: el fichero que sirve existe realmente en disco');

  // ES no se rompe: sigue existiendo y sirviendo su propio fichero.
  const esHandler = getRouteHandler(indexRouter, 'get', '/privacy-policy');
  sentPath = null;
  esHandler({}, res);
  ok(sentPath && sentPath.endsWith('privacy-policy.html') && !sentPath.includes('-de') && !sentPath.includes('-fr'), 'GET /privacy-policy (ES) sigue sirviendo views/privacy-policy.html sin cambios');
}

// =======================================================================
// 4) Estructura idéntica ES/DE/FR (traducción fiel, no reescritura)
// =======================================================================
function checkPrivacyPagesSameStructure() {
  const es = readView('privacy-policy.html');
  const de = readView('privacy-policy-de.html');
  const fr = readView('privacy-policy-fr.html');

  const h2Count = html => (html.match(/<h2>/g) || []).length;
  const h3Count = html => (html.match(/<h3>/g) || []).length;

  eq(h2Count(de), h2Count(es), 'privacy-policy-de.html tiene el mismo número de secciones <h2> que la versión ES');
  eq(h2Count(fr), h2Count(es), 'privacy-policy-fr.html tiene el mismo número de secciones <h2> que la versión ES');
  eq(h3Count(de), h3Count(es), 'privacy-policy-de.html tiene el mismo número de subsecciones <h3> que la versión ES');
  eq(h3Count(fr), h3Count(es), 'privacy-policy-fr.html tiene el mismo número de subsecciones <h3> que la versión ES');

  // Mismo diseño/estilo: la caja destacada de "Tratamiento Especial de
  // Imágenes" con el mismo borde/color debe seguir presente en las 3.
  const styleMarker = 'border-left: 4px solid #3498db';
  ok(es.includes(styleMarker) && de.includes(styleMarker) && fr.includes(styleMarker), 'las 3 versiones conservan el mismo bloque destacado de tratamiento de fotos, con el mismo estilo');

  // lang correcto y no contienen texto español fuera de lo esperado (título/H1).
  ok(/<html lang="de">/.test(de), 'privacy-policy-de.html declara lang="de"');
  ok(/<html lang="fr">/.test(fr), 'privacy-policy-fr.html declara lang="fr"');
  ok(/Datenschutzerklärung/.test(de) && !/Política de Privacidad/.test(de) && !/Politique de Confidentialité/.test(de), 'privacy-policy-de.html usa el título alemán, sin restos de ES/FR');
  ok(/Politique de Confidentialité/.test(fr) && !/Política de Privacidad/.test(fr) && !/Datenschutzerklärung/.test(fr), 'privacy-policy-fr.html usa el título francés, sin restos de ES/DE');
}

// =======================================================================
// 5) customization.js: i18n mínimo centralizado, mismo mecanismo que shop.js/home.js
// =======================================================================
function loadCustomizationSandbox(lang) {
  const sandbox = {
    console,
    document: { documentElement: lang !== undefined ? { lang } : undefined, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, remove() {} }) },
    AbortController,
    fetch: async () => ({ ok: false, json: async () => ({ ok: false }) })
  };
  vm.createContext(sandbox);
  vm.runInContext(readFile('public/js/customization.js'), sandbox, { filename: 'customization.js' });
  return sandbox;
}

function checkCustomizationI18n() {
  const src = readFile('public/js/customization.js');
  ok(/const CUSTOMIZATION_I18N/.test(src), 'customization.js define un diccionario i18n centralizado (una sola copia del archivo, sin triplicarlo)');
  ok(/document\.documentElement\.lang/.test(src), 'customization.js usa el mismo mecanismo de idioma que shop.js/home.js (document.documentElement.lang)');
  ok(!/CUSTOMIZATION_I18N[\s\S]*CUSTOMIZATION_I18N[\s\S]*CUSTOMIZATION_I18N/.test(readFile('public/js/shop.js') + readFile('public/js/home.js')), 'shop.js/home.js no duplican el diccionario (vive solo en customization.js)');

  // --- Regresión ES: mismo texto exacto que existía antes de esta auditoría ---
  {
    const sandbox = loadCustomizationSandbox('es');
    eq(sandbox.t('modalTitle', 'Litofanía Test'), 'Personalizar: Litofanía Test', "es: modalTitle idéntico al texto original hardcodeado");
    eq(sandbox.t('uploadAtLeastOne'), 'Por favor sube al menos una foto', 'es: uploadAtLeastOne idéntico al original');
    eq(sandbox.t('selectModel'), 'Por favor selecciona un modelo', 'es: selectModel idéntico al original');
    eq(sandbox.t('addedToCart'), '✨ Producto añadido al carrito', 'es: addedToCart idéntico al original');
    eq(sandbox.t('maxPhotos', 3), 'Máximo 3 archivos permitidos', 'es: maxPhotos idéntico al original');
  }

  // --- Sin document.documentElement (sandboxes de test existentes, p.ej.
  // check-frontend-selections.js) -> cae a 'es', el mismo texto de siempre ---
  {
    const sandbox = loadCustomizationSandbox(undefined);
    eq(sandbox.t('uploadAtLeastOne'), 'Por favor sube al menos una foto', 'sin document.documentElement: cae a es (mismo texto que antes de existir i18n)');
  }

  // --- DE: texto realmente traducido ---
  {
    const sandbox = loadCustomizationSandbox('de');
    eq(sandbox.t('modalTitle', 'Litofanía Test'), 'Personalisieren: Litofanía Test', 'de: modalTitle traducido');
    eq(sandbox.t('uploadAtLeastOne'), 'Bitte lade mindestens ein Foto hoch', 'de: uploadAtLeastOne traducido');
    eq(sandbox.t('selectModel'), 'Bitte wähle ein Modell aus', 'de: selectModel traducido');
    eq(sandbox.t('addedToCart'), '✨ Produkt zum Warenkorb hinzugefügt', 'de: addedToCart traducido');
    eq(sandbox.t('maxPhotos', 3), 'Maximal 3 Dateien erlaubt', 'de: maxPhotos traducido');
  }

  // --- FR: texto realmente traducido ---
  {
    const sandbox = loadCustomizationSandbox('fr');
    eq(sandbox.t('modalTitle', 'Litofanía Test'), 'Personnaliser : Litofanía Test', 'fr: modalTitle traducido');
    eq(sandbox.t('uploadAtLeastOne'), 'Veuillez téléverser au moins une photo', 'fr: uploadAtLeastOne traducido');
    eq(sandbox.t('selectModel'), 'Veuillez sélectionner un modèle', 'fr: selectModel traducido');
    eq(sandbox.t('addedToCart'), '✨ Produit ajouté au panier', 'fr: addedToCart traducido');
    eq(sandbox.t('maxPhotos', 3), 'Maximum 3 fichiers autorisés', 'fr: maxPhotos traducido');
  }

  // --- Idioma no soportado -> cae a es (nunca undefined/crash) ---
  {
    const sandbox = loadCustomizationSandbox('it');
    eq(sandbox.t('selectModel'), 'Por favor selecciona un modelo', 'idioma no soportado (it): cae a es, nunca revienta ni deja texto vacío');
  }
}

// =======================================================================
// 6) home.js: pasa ?lang= igual que shop.js (regresión del bug reportado)
// =======================================================================
function checkHomeJsPassesLang() {
  const homeSrc = readFile('public/js/home.js');
  const shopSrc = readFile('public/js/shop.js');
  ok(/document\.documentElement\.lang/.test(homeSrc), 'home.js#loadFeaturedProducts lee document.documentElement.lang (antes no lo hacía)');
  ok(/fetch\(`\/api\/productos\?lang=\$\{lang\}`\)/.test(homeSrc), 'home.js pide /api/productos?lang=${lang}, igual que shop.js');
  ok(/fetch\(`\/api\/productos\?lang=\$\{lang\}`\)/.test(shopSrc), 'sanity: shop.js sigue con el mismo patrón (no se tocó)');

  // Ejercicio real: sandbox captura la URL exacta que pide home.js para lang='de'.
  const calls = [];
  const sandbox = {
    console,
    document: {
      documentElement: { lang: 'de' },
      getElementById: () => ({ innerHTML: '' }),
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    fetch: async (url) => { calls.push(url); return { ok: true, json: async () => [] }; },
    setCustomizationProducts: () => {}
  };
  vm.createContext(sandbox);
  vm.runInContext(readFile('public/js/home.js'), sandbox, { filename: 'home.js' });
  return sandbox.loadFeaturedProducts().then(() => {
    ok(calls.some(u => u === '/api/productos?lang=de'), `home.js con <html lang="de"> pide /api/productos?lang=de; llamadas reales=${JSON.stringify(calls)}`);
  });
}

// =======================================================================
// 7) routes/productos.js: traduce si hay datos, cae a ES si no los hay
// =======================================================================
function makeFakeProductsPool(products) {
  return {
    async query(sql) {
      if (/FROM productos WHERE activo = TRUE/i.test(sql)) return [products];
      if (/FROM productos WHERE id = \?/i.test(sql)) return [products.slice(0, 1)];
      throw new Error(`Fake products pool: consulta no reconocida -- ${sql}`);
    }
  };
}

async function checkProductosApiTranslatesWhenDataExists() {
  const productosRouter = require('../routes/productos');
  const listHandler = getRouteHandler(productosRouter, 'get', '/api/productos');
  const dbConfig = require('../config/db');

  const idTranslated = 80001 + Math.floor(Math.random() * 1000);
  const idUntranslated = 81001 + Math.floor(Math.random() * 1000);
  dbConfig.pool.query = makeFakeProductsPool([
    { id: idTranslated, nombre: 'Nombre ES', descripcion: 'Desc ES', nombre_de: 'Name DE', nombre_fr: 'Nom FR', descripcion_de: 'Beschreibung DE', descripcion_fr: 'Description FR', precio: '10.00' },
    { id: idUntranslated, nombre: 'Solo ES', descripcion: 'Solo descripcion ES', nombre_de: null, nombre_fr: null, descripcion_de: null, descripcion_fr: null, precio: '5.00' }
  ]).query;

  const resEs = { json(d) { this.body = d; } };
  await listHandler({ query: {} }, resEs);
  const es = Object.fromEntries(resEs.body.map(p => [p.id, p]));
  eq(es[idTranslated].nombre, 'Nombre ES', 'lang=es (por defecto): usa el nombre español, no traduce');

  const resDe = { json(d) { this.body = d; } };
  await listHandler({ query: { lang: 'de' } }, resDe);
  const de = Object.fromEntries(resDe.body.map(p => [p.id, p]));
  eq(de[idTranslated].nombre, 'Name DE', 'lang=de: usa nombre_de cuando existe en BD');
  eq(de[idTranslated].descripcion, 'Beschreibung DE', 'lang=de: usa descripcion_de cuando existe en BD');
  eq(de[idUntranslated].nombre, 'Solo ES', 'lang=de: SIN nombre_de en BD, cae a español -- nunca inventa una traducción');

  const resFr = { json(d) { this.body = d; } };
  await listHandler({ query: { lang: 'fr' } }, resFr);
  const fr = Object.fromEntries(resFr.body.map(p => [p.id, p]));
  eq(fr[idTranslated].nombre, 'Nom FR', 'lang=fr: usa nombre_fr cuando existe en BD');
  eq(fr[idUntranslated].nombre, 'Solo ES', 'lang=fr: SIN nombre_fr en BD, cae a español');
}

async function main() {
  console.log('Auditoría i18n público - WhatsApp (checkout-de/fr)');
  checkWhatsappTooltipLocalized();
  console.log('Auditoría i18n público - enlaces de privacidad en todas las vistas DE/FR');
  checkPrivacyLinksLocalizedEverywhere();
  console.log('Auditoría i18n público - rutas reales de privacidad (ES/DE/FR)');
  checkPrivacyRoutesServeRealFiles();
  console.log('Auditoría i18n público - misma estructura en las 3 versiones de privacidad');
  checkPrivacyPagesSameStructure();
  console.log('Auditoría i18n público - customization.js (i18n mínimo centralizado)');
  checkCustomizationI18n();
  console.log('Auditoría i18n público - home.js pasa ?lang= (regresión)');
  await checkHomeJsPassesLang();
  console.log('Auditoría i18n público - routes/productos.js traduce nombres/descripciones dinámicos');
  await checkProductosApiTranslatesWhenDataExists();
  console.log(`OK: ${checks} comprobaciones sobre la auditoría de i18n público DE/FR.`);
}

main().catch(err => {
  console.error('FALLO en check-i18n-public.js:', err.message, err.stack);
  process.exit(1);
});
