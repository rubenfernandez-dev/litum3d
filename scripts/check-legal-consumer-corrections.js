/*
  LITUM3D - Test de regresión: saneamiento jurídico ES/DE/FR (informe
  "sanear contenido jurídico" -- separación estricta entre correcciones
  seguras de texto y datos fiscales/societarios/jurisdiccionales que NO se
  inventan).

  Cubre EXCLUSIVAMENTE las correcciones seguras aplicadas a Terms/Privacy/
  Cookies (ES/DE/FR):
  1) Ningún documento legal menciona ya litum3d.es (dominio operativo real:
     litum3d.com).
  2) Ningún documento legal enlaza ya a /contact.html (ruta inexistente);
     cada idioma usa su ruta real (/contact, /contact-de, /contact-fr).
  3) La garantía ya no cita el RGPD/GDPR/DSGVO como fundamento.
  4) El desistimiento ya no cita el RGPD/GDPR/DSGVO como fundamento.
  5) Existe una cláusula de excepción para productos personalizados en los
     tres idiomas (Terms), y aclara que no elimina los derechos del cliente
     ante producto defectuoso/no conforme.
  6) Las 9 rutas legales (terms-conditions, privacy-policy, cookies-policy
     x ES/DE/FR) siguen registradas y sirviendo el fichero real.
  7) currency sigue siendo 'eur' y ALLOWED_CHECKOUT_COUNTRIES sigue siendo
     exactamente ES/PT/FR/CH/DE/IT (fuera de alcance de este saneamiento de
     texto legal -- ver config/checkout-countries.js). VAT_PERCENT es 0
     (saneamiento fiscal técnico posterior, ver config/pricing.js: LITUM3D
     no tiene registro VAT/MWST y no desglosa IVA; totalCents/PVP no
     cambian, ver services/pricing.js).

  Uso: node scripts/check-legal-consumer-corrections.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }

const VIEWS_DIR = path.join(__dirname, '..', 'views');
function readView(name) {
  return fs.readFileSync(path.join(VIEWS_DIR, name), 'utf8');
}

const LEGAL_FILES = [
  'terms-conditions.html', 'terms-conditions-de.html', 'terms-conditions-fr.html',
  'privacy-policy.html', 'privacy-policy-de.html', 'privacy-policy-fr.html',
  'cookies-policy.html', 'cookies-policy-de.html', 'cookies-policy-fr.html'
];

// ==========================================================================
// 1) Dominio: sin litum3d.es en ningún documento legal
// ==========================================================================
function checkNoObsoleteDomain() {
  for (const file of LEGAL_FILES) {
    const html = readView(file);
    ok(!/litum3d\.es/i.test(html), `views/${file}: no debe contener "litum3d.es" (dominio obsoleto; el real es litum3d.com)`);
  }
}

// ==========================================================================
// 2) Contacto: sin /contact.html (ruta inexistente) en ningún documento legal
// ==========================================================================
function checkNoBrokenContactLink() {
  for (const file of LEGAL_FILES) {
    const html = readView(file);
    ok(!/\/contact\.html/.test(html), `views/${file}: no debe enlazar a "/contact.html" (ruta inexistente)`);
  }

  const expectedContactRoute = {
    'terms-conditions.html': '/contact',
    'terms-conditions-de.html': '/contact-de',
    'terms-conditions-fr.html': '/contact-fr'
  };
  for (const [file, route] of Object.entries(expectedContactRoute)) {
    const html = readView(file);
    ok(html.includes(`href="${route}"`), `views/${file}: el enlace de contacto usa la ruta real ${route}`);
  }
}

// ==========================================================================
// 3) Garantía: sin RGPD/GDPR/DSGVO como fundamento
// ==========================================================================
function checkWarrantyDoesNotCiteDataProtectionLaw() {
  const TERMS = ['terms-conditions.html', 'terms-conditions-de.html', 'terms-conditions-fr.html'];
  for (const file of TERMS) {
    const html = readView(file);
    const warrantyMatch = html.match(/<h2>11\.[\s\S]*?(?=<h2>12\.)/);
    ok(!!warrantyMatch, `views/${file}: existe la sección 11 (Garantía/Gewährleistung/Garantie)`);
    if (warrantyMatch) {
      // RGPD/DSGVO puede aparecer para ACLARAR que no es el fundamento (p.ej.
      // "independiente de la normativa de protección de datos (RGPD)"); lo
      // que no debe aparecer es la vieja atribución "según el RGPD/DSGVO".
      ok(!/según el RGPD|gemäß der europäischen DSGVO|conformément au RGPD/i.test(warrantyMatch[0]),
        `views/${file}: la sección de garantía ya no atribuye su fundamento al RGPD/GDPR/DSGVO`);
    }
  }
}

// ==========================================================================
// 4) Desistimiento: sin RGPD/GDPR/DSGVO como fundamento
// ==========================================================================
function checkWithdrawalDoesNotCiteDataProtectionLaw() {
  const TERMS = ['terms-conditions.html', 'terms-conditions-de.html', 'terms-conditions-fr.html'];
  for (const file of TERMS) {
    const html = readView(file);
    const withdrawalMatch = html.match(/<h2>7\.[\s\S]*?(?=<h2>8\.)/);
    ok(!!withdrawalMatch, `views/${file}: existe la sección 7 (Devoluciones/Rückgabe/Retours)`);
    if (withdrawalMatch) {
      // "RGPD"/"DSGVO" pueden aparecer para EXPLICAR que no es el fundamento
      // (p.ej. "no se fundamenta en el RGPD"), nunca como base del derecho.
      ok(!/\(Derecho de Desistimiento - RGPD\)|\(Widerrufsrecht - DSGVO\)|\(Droit de Rétractation - RGPD\)/.test(withdrawalMatch[0]),
        `views/${file}: el desistimiento ya no atribuye su fundamento al RGPD/GDPR/DSGVO`);
    }
  }
}

// ==========================================================================
// 5) Cláusula de excepción para productos personalizados, en los 3 idiomas,
//    y separación explícita de "defectuoso/no conforme"
// ==========================================================================
function checkPersonalizedProductsExceptionExists() {
  const EXPECTATIONS = [
    { file: 'terms-conditions.html', exceptionMarker: 'Excepción: Productos Personalizados', defectMarker: 'no conforme' },
    { file: 'terms-conditions-de.html', exceptionMarker: 'Ausnahme: Personalisierte Produkte', defectMarker: 'Sachmangel' },
    { file: 'terms-conditions-fr.html', exceptionMarker: 'Exception : Produits Personnalisés', defectMarker: 'défaut de conformité' }
  ];
  for (const { file, exceptionMarker, defectMarker } of EXPECTATIONS) {
    const html = readView(file);
    ok(html.includes(exceptionMarker), `views/${file}: existe la cláusula de excepción de desistimiento para productos personalizados`);
    ok(html.includes(defectMarker), `views/${file}: la sección de desistimiento distingue el caso de producto defectuoso/no conforme`);
  }
}

// ==========================================================================
// 6) Las 9 rutas legales siguen registradas y sirven el fichero real
// ==========================================================================
function getRouteHandler(router, method, routePath) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  return layer ? layer.route.stack[0].handle : null;
}

function checkAllNineLegalRoutesServeRealFiles() {
  const indexRouter = require('../routes/index');
  const ROUTES = [
    ['/terms-conditions', 'terms-conditions.html'],
    ['/terms-conditions-de', 'terms-conditions-de.html'],
    ['/terms-conditions-fr', 'terms-conditions-fr.html'],
    ['/privacy-policy', 'privacy-policy.html'],
    ['/privacy-policy-de', 'privacy-policy-de.html'],
    ['/privacy-policy-fr', 'privacy-policy-fr.html'],
    ['/cookies-policy', 'cookies-policy.html'],
    ['/cookies-policy-de', 'cookies-policy-de.html'],
    ['/cookies-policy-fr', 'cookies-policy-fr.html']
  ];
  for (const [route, file] of ROUTES) {
    const handler = getRouteHandler(indexRouter, 'get', route);
    ok(!!handler, `GET ${route}: sigue registrado en routes/index.js`);
    let sentPath = null;
    handler({}, { sendFile: (p) => { sentPath = p; } });
    ok(sentPath && sentPath.endsWith(file), `GET ${route}: sirve views/${file}`);
    ok(fs.existsSync(sentPath), `GET ${route}: el fichero que sirve existe realmente en disco`);
  }
}

// ==========================================================================
// 7) currency/países de checkout intactos; VAT_PERCENT=0 (saneamiento
//    fiscal técnico: LITUM3D no desglosa IVA, ver config/pricing.js)
// ==========================================================================
function checkFiscalAndCheckoutConfigUntouched() {
  const pricingConfig = require('../config/pricing');
  ok(pricingConfig.VAT_PERCENT === 0, `config/pricing.js: VAT_PERCENT es 0 (sin desglose de IVA; LITUM3D no tiene registro VAT/MWST)`);
  ok(pricingConfig.currency === 'eur', `config/pricing.js: currency sigue siendo 'eur' (no se ha tocado pricing en esta tarea)`);

  const { ALLOWED_CHECKOUT_COUNTRIES } = require('../config/checkout-countries');
  const expected = ['ES', 'PT', 'FR', 'CH', 'DE', 'IT'];
  assert.deepStrictEqual([...ALLOWED_CHECKOUT_COUNTRIES], expected, 'config/checkout-countries.js: ALLOWED_CHECKOUT_COUNTRIES no se ha tocado en esta tarea');
  checks++;
}

function main() {
  checkNoObsoleteDomain();
  checkNoBrokenContactLink();
  checkWarrantyDoesNotCiteDataProtectionLaw();
  checkWithdrawalDoesNotCiteDataProtectionLaw();
  checkPersonalizedProductsExceptionExists();
  checkAllNineLegalRoutesServeRealFiles();
  checkFiscalAndCheckoutConfigUntouched();

  console.log(`OK: ${checks} comprobaciones sobre el saneamiento jurídico ES/DE/FR (Terms/Privacy/Cookies).`);
}

main();
