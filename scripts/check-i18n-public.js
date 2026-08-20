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
  9) Navegación internacional (informe de corrección de navegación): TODO
     href interno (no /img,/css,/js,/api, no externo, no ancla) de
     cualquier vista *-de.html/*-fr.html descubierta dinámicamente resuelve
     a una ruta REAL registrada en routes/index.js -- nunca una URL
     inventada como /index-de o /index-fr, que 404eaban. Y ningún enlace de
     navegación (tienda/about/contact/gallery/cart/checkout/testimonios)
     apunta a la página ES SALVO la opción "Español" del propio selector de
     idioma, que debe seguir yendo a ES a propósito.
  10) public/js/cart-page.js: el enlace "Explorar Productos" del carrito
      vacío usa el mismo mecanismo de idioma que continueShopping()/
      goToCheckout() del mismo archivo (antes iba siempre a /gallery, ES).

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

// =======================================================================
// 9) Navegación internacional: todo href interno resuelve a una ruta real,
//    y ningún enlace de navegación manda a la versión ES por accidente.
// =======================================================================

// Rutas GET realmente registradas en routes/index.js, extraídas del texto
// fuente -- no una lista hardcodeada, para que un cambio real en el router
// se refleje aquí automáticamente.
function getRegisteredGetRoutes() {
  const src = readFile('routes/index.js');
  const routes = new Set();
  const re = /router\.get\('([^']+)'/g;
  let m;
  while ((m = re.exec(src))) routes.add(m[1]);
  return routes;
}

// Extrae los <a ...>, con su href y (si existe) su title, para poder
// distinguir la opción "Español" del selector de idioma (que SÍ debe ir a
// ES a propósito) de cualquier otro enlace de navegación.
function extractInternalPageLinks(html) {
  const anchorRe = /<a\s+[^>]*href="(\/[^"]*)"[^>]*>/g;
  const links = [];
  let m;
  while ((m = anchorRe.exec(html))) {
    const href = m[1];
    if (/^\/(img|css|js|api)\//.test(href)) continue; // assets/API, no son "página"
    const tag = m[0];
    const titleMatch = tag.match(/title="([^"]*)"/);
    links.push({ href, title: titleMatch ? titleMatch[1] : null });
  }
  return links;
}

function checkInternalLinksResolveToRealLocalizedRoutes() {
  const registeredRoutes = getRegisteredGetRoutes();
  ok(registeredRoutes.size >= 20, `sanity: se descubrieron ${registeredRoutes.size} rutas GET registradas en routes/index.js`);

  const deViews = listViews(/-de\.html$/);
  const frViews = listViews(/-fr\.html$/);

  // Páginas de navegación con versión localizada real: un enlace DE/FR a
  // ellas debe usar la variante -de/-fr, NUNCA la desnuda (ES), salvo que
  // sea explícitamente la opción "Español" del selector de idioma.
  const NAV_TARGETS_WITH_LOCALE = ['shop', 'tienda', 'about', 'contact', 'gallery', 'cart', 'checkout', 'testimonios', 'privacy-policy', 'cookies-policy', 'terms-conditions'];

  for (const [views, suffix, langLabel] of [[deViews, '-de', 'Deutsch'], [frViews, '-fr', 'Français']]) {
    for (const file of views) {
      const html = readView(file);
      const links = extractInternalPageLinks(html);

      for (const { href, title } of links) {
        // 9a) toda URL interna referenciada debe ser una ruta real (nunca inventada).
        ok(registeredRoutes.has(href), `views/${file}: href="${href}" debe ser una ruta real registrada en routes/index.js (nunca inventada, p.ej. /index${suffix})`);

        // 9b) si el destino conceptual es una de las páginas con versión
        // localizada, el href no debe ser la variante ES desnuda -- salvo
        // que sea la propia opción "Español" del selector de idioma.
        const bareName = href.replace(/^\//, '');
        const isSpanishLangOption = title === 'Español';
        if (NAV_TARGETS_WITH_LOCALE.includes(bareName) && !isSpanishLangOption) {
          ok(false, `views/${file}: href="${href}" manda a la versión ES en vez de mantener el idioma de la página (esperado: algo terminado en "${suffix}")`);
        }
      }
    }
  }
}

function checkShopLinksUseLocalizedRoute() {
  const de = readView('shop-de.html');
  const fr = readView('shop-fr.html');
  // Autorreferencia correcta: dentro de sus propias páginas, la tienda
  // DE/FR enlaza a sí misma (nav + footer), no a /shop ni /tienda (ES).
  ok((de.match(/href="\/shop-de"/g) || []).length >= 2, 'shop-de.html: los enlaces de navegación a la tienda usan /shop-de (nav + footer)');
  ok((fr.match(/href="\/shop-fr"/g) || []).length >= 2, 'shop-fr.html: los enlaces de navegación a la tienda usan /shop-fr (nav + footer)');
}

// =======================================================================
// 10) cart-page.js: el enlace de carrito vacío ya respeta el idioma
// =======================================================================
function checkCartPageEmptyStateRespectsLocale() {
  const src = readFile('public/js/cart-page.js');
  ok(/document\.documentElement\.lang/.test(src), 'cart-page.js usa document.documentElement.lang (mismo mecanismo que continueShopping/goToCheckout)');
  ok(!/href="\/gallery"/.test(src), 'cart-page.js ya no tiene un href="/gallery" fijo (ahora es dinámico según el idioma)');

  // document.documentElement (el propio <html>) siempre existe en un
  // navegador real -- a diferencia de customization.js#t(), que sí debe
  // tolerar sandboxes de test sin document.documentElement, aquí solo se
  // ejercitan valores de lang realistas.
  for (const [lang, expected] of [['de', '/gallery-de'], ['fr', '/gallery-fr'], ['es', '/gallery']]) {
    const registry = new Map();
    const getEl = (id) => {
      if (!registry.has(id)) registry.set(id, id === 'cart-items-container' ? { innerHTML: '' } : { style: {} });
      return registry.get(id);
    };
    const sandbox = {
      console,
      document: {
        documentElement: { lang },
        getElementById: getEl,
        addEventListener: () => {}
      },
      getCart: () => [],
      normalizeCart: (c) => ({ cart: c, changed: false }),
      saveCart: () => {}
    };
    vm.createContext(sandbox);
    vm.runInContext(readFile('public/js/cart-page.js'), sandbox, { filename: 'cart-page.js' });
    sandbox.renderCartItems();
    const html = getEl('cart-items-container').innerHTML;
    ok(html.includes(`href="${expected}"`), `carrito vacío con lang=${lang}: el enlace "Explorar Productos" apunta a ${expected}; html=${html.slice(0, 200)}`);
  }
}

// =======================================================================
// 11) Localización jurídica Terms/Cookies (informe de localización legal
//    pública DE/FR): existencia, rutas, footers y paridad estructural,
//    mismo patrón ya validado para Privacy -- y confirmación de que las
//    páginas ES no se alteraron.
// =======================================================================

const LEGAL_DOCS = [
  // esH2/esH3 actualizados tras fix(legal): correct consumer and policy
  // inconsistencies (consolidación §13/§16 -> -1 h2; reescritura de la
  // cláusula de desistimiento en 2 h3 nuevos en vez de 1 -> +1 h3); tras
  // fix(legal): identify Litum3D operator (informe "cerrar identificación
  // legal del operador", 2026-08-20): +1 h2 nueva sección "Identificación
  // del Vendedor / Operador"; y tras fix(legal): align location and
  // jurisdiction (informe "correcciones finales antes del push",
  // 2026-08-20): la cláusula de Jurisdicción (Madrid/Zúrich) se fusiona con
  // Derecho Aplicable en un único h3 neutral -> -1 h3, aplicado por igual en
  // ES/DE/FR (ver scripts/check-legal-operator-identity.js para su contenido).
  { key: 'terms-conditions', esFile: 'terms-conditions.html', esH2: 16, esH3: 23, name: 'Terms' },
  { key: 'cookies-policy', esFile: 'cookies-policy.html', esH2: 8, esH3: 8, name: 'Cookies' }
];

function checkLegalPagesExistAndUnchanged() {
  for (const { key, esFile, esH2, esH3, name } of LEGAL_DOCS) {
    for (const suffix of ['-de', '-fr']) {
      const file = `views/${key}${suffix}.html`;
      ok(fs.existsSync(path.join(__dirname, '..', file)), `${file} existe`);
    }
    // ES no se alteró sustantivamente: mismo número de secciones que antes
    // de esta tarea (línea base tomada del propio fichero ES antes de tocar nada).
    const esHtml = readView(esFile);
    ok(/<html lang="es">/.test(esHtml), `views/${esFile}: sigue siendo lang="es", sin tocar`);
    eq((esHtml.match(/<h2>/g) || []).length, esH2, `views/${esFile} (${name}): conserva sus ${esH2} secciones <h2> originales (no se alteró)`);
    eq((esHtml.match(/<h3>/g) || []).length, esH3, `views/${esFile} (${name}): conserva sus ${esH3} subsecciones <h3> originales (no se alteró)`);
  }
}

function checkLegalRoutesRegisteredAndServeRealFiles() {
  const indexRouter = require('../routes/index');
  const res = { sendFile: null };
  for (const { key } of LEGAL_DOCS) {
    for (const suffix of ['-de', '-fr']) {
      const handler = getRouteHandler(indexRouter, 'get', `/${key}${suffix}`);
      let sentPath = null;
      handler({}, { sendFile: (p) => { sentPath = p; } });
      ok(sentPath && sentPath.endsWith(`${key}${suffix}.html`), `GET /${key}${suffix} sirve views/${key}${suffix}.html`);
      ok(fs.existsSync(sentPath), `GET /${key}${suffix}: el fichero que sirve existe realmente en disco`);
    }
  }
}

function checkLegalFootersLocalizedEverywhere() {
  const deViews = listViews(/-de\.html$/).filter(f => !f.startsWith('terms-conditions') && !f.startsWith('cookies-policy'));
  const frViews = listViews(/-fr\.html$/).filter(f => !f.startsWith('terms-conditions') && !f.startsWith('cookies-policy'));

  for (const { key } of LEGAL_DOCS) {
    for (const file of deViews) {
      const html = readView(file);
      if (!html.includes(`/${key}`)) continue; // esta vista no enlaza a este documento, no aplica
      ok(!html.includes(`href="/${key}"`), `views/${file}: ningún enlace a ${key} apunta a la versión ES`);
      ok(html.includes(`href="/${key}-de"`), `views/${file}: el enlace a ${key} apunta a /${key}-de`);
    }
    for (const file of frViews) {
      const html = readView(file);
      if (!html.includes(`/${key}`)) continue;
      ok(!html.includes(`href="/${key}"`), `views/${file}: ningún enlace a ${key} apunta a la versión ES`);
      ok(html.includes(`href="/${key}-fr"`), `views/${file}: el enlace a ${key} apunta a /${key}-fr`);
    }
  }
}

function checkLegalPagesStructuralParity() {
  for (const { key, esFile, name } of LEGAL_DOCS) {
    const es = readView(esFile);
    const de = readView(`${key}-de.html`);
    const fr = readView(`${key}-fr.html`);

    const h2Count = html => (html.match(/<h2>/g) || []).length;
    const h3Count = html => (html.match(/<h3>/g) || []).length;
    const listCount = html => (html.match(/<(ul|ol|table)[ >]/g) || []).length;

    eq(h2Count(de), h2Count(es), `${name}: -de.html tiene el mismo número de secciones <h2> que ES`);
    eq(h2Count(fr), h2Count(es), `${name}: -fr.html tiene el mismo número de secciones <h2> que ES`);
    eq(h3Count(de), h3Count(es), `${name}: -de.html tiene el mismo número de subsecciones <h3> que ES`);
    eq(h3Count(fr), h3Count(es), `${name}: -fr.html tiene el mismo número de subsecciones <h3> que ES`);
    eq(listCount(de), listCount(es), `${name}: -de.html tiene el mismo número de listas/tablas que ES`);
    eq(listCount(fr), listCount(es), `${name}: -fr.html tiene el mismo número de listas/tablas que ES`);

    ok(/<html lang="de">/.test(de), `${name}-de.html declara lang="de"`);
    ok(/<html lang="fr">/.test(fr), `${name}-fr.html declara lang="fr"`);

    // Mismo pie de página/estilo (.policy-nav/.policy-container/.policy-footer), sin rediseño.
    for (const html of [de, fr]) {
      ok(html.includes('policy-nav') && html.includes('policy-container') && html.includes('policy-footer'), `${name}: conserva las clases policy-nav/policy-container/policy-footer (mismo diseño que ES)`);
    }
  }
}

function checkPrivacyStillLocalizedAfterThisTask() {
  // No debe haberse roto por los cambios de esta tarea (sección 8/9 del
  // informe): mismas 3 rutas ya validadas en checkPrivacyRoutesServeRealFiles.
  for (const file of ['views/privacy-policy.html', 'views/privacy-policy-de.html', 'views/privacy-policy-fr.html']) {
    ok(fs.existsSync(path.join(__dirname, '..', file)), `${file} sigue existiendo`);
  }
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
  console.log('Corrección de navegación - todo href interno resuelve a una ruta real y mantiene el idioma');
  checkInternalLinksResolveToRealLocalizedRoutes();
  console.log('Corrección de navegación - Shop DE/FR se autorreferencia con su propia ruta');
  checkShopLinksUseLocalizedRoute();
  console.log('Corrección de navegación - cart-page.js: enlace de carrito vacío respeta el idioma');
  checkCartPageEmptyStateRespectsLocale();
  console.log('Localización jurídica - Terms/Cookies DE/FR existen y ES no se alteró');
  checkLegalPagesExistAndUnchanged();
  console.log('Localización jurídica - rutas reales de Terms/Cookies DE/FR');
  checkLegalRoutesRegisteredAndServeRealFiles();
  console.log('Localización jurídica - footers DE/FR enlazan a Terms/Cookies localizados');
  checkLegalFootersLocalizedEverywhere();
  console.log('Localización jurídica - paridad estructural Terms/Cookies ES/DE/FR');
  checkLegalPagesStructuralParity();
  console.log('Localización jurídica - Privacy sigue correctamente localizada');
  checkPrivacyStillLocalizedAfterThisTask();
  console.log(`OK: ${checks} comprobaciones sobre la auditoría de i18n público DE/FR.`);
}

main().catch(err => {
  console.error('FALLO en check-i18n-public.js:', err.message, err.stack);
  process.exit(1);
});
