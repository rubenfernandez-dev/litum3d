/*
  LITUM3D - Test de regresión: identificación legal del operador (informe
  "cerrar identificación legal del operador de LITUM3D", 2026-08-20).

  LITUM3D es actualmente una marca/nombre comercial, NO una sociedad
  constituida: el operador real es una persona física (Ruben Fernandez).
  Este test cubre EXACTAMENTE lo que pidió el informe:
    - Contact ES/DE/FR muestra con claridad marca + "Operado por/Betreiber/
      Exploité par" + Ruben Fernandez + dirección real + contacto.
    - Terms ES/DE/FR identifica al vendedor/operador con los mismos datos.
    - Privacy ES/DE/FR identifica al responsable del tratamiento con los
      mismos datos.
    - En NINGUNA página pública se afirma forma societaria (GmbH/AG/SL/
      Sàrl/sociedad anónima/empresa registrada) ni se inventa un número
      fiscal/UID/VAT -- LITUM3D no tiene ninguno de estos hoy.
    - La dirección real NO se filtra fuera de Contact/Terms/Privacy (footer
      global se mantiene limpio, sin bloque legal nuevo).
    - ES/DE/FR: "Operado por"/"Betreiber"/"Exploité par", país sin traducir
      el nombre/dirección (Suiza/Schweiz/Suisse).

  Uso: node scripts/check-legal-operator-identity.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }

const ROOT = path.join(__dirname, '..');
const VIEWS_DIR = path.join(ROOT, 'views');
function readView(name) { return fs.readFileSync(path.join(VIEWS_DIR, name), 'utf8'); }

function listPublicViews() {
  return fs.readdirSync(VIEWS_DIR).filter(f =>
    f.endsWith('.html') && !f.startsWith('admin-') && f !== '404.html'
  );
}

const OPERATOR_NAME = 'Ruben Fernandez';
const ADDRESS_LINE_1 = 'Hauptstrasse 50';
const ADDRESS_LINE_2 = '2576 Lüscherz';
const REAL_EMAIL = 'contact@litum3d.com';
const REAL_PHONE = '+41 77 218 62 29';

const COUNTRY_BY_LOCALE = { '': 'Suiza', '-de': 'Schweiz', '-fr': 'Suisse' };
const OPERATED_BY_LABEL = { '': 'Operado por', '-de': 'Betreiber', '-fr': 'Exploité par' };

// Páginas donde la dirección/identidad real DEBE aparecer (las únicas
// aprobadas por el informe) -- fuera de estas, la dirección no debe
// filtrarse (footer/resto del sitio se mantienen limpios).
const IDENTITY_PAGES = ['contact', 'terms-conditions', 'privacy-policy'];
const LOCALES = ['', '-de', '-fr'];

// =======================================================================
// 1) Contact ES/DE/FR: marca + "Operado por/Betreiber/Exploité par" +
//    nombre + dirección real + contacto, integrado en el diseño existente.
// =======================================================================
function checkContactPagesShowOperatorIdentity() {
  for (const locale of LOCALES) {
    const html = readView(`contact${locale}.html`);
    ok(html.includes('LITUM3D'), `contact${locale}.html: muestra la marca LITUM3D`);
    ok(html.includes(OPERATED_BY_LABEL[locale]), `contact${locale}.html: usa la etiqueta localizada "${OPERATED_BY_LABEL[locale]}"`);
    ok(html.includes(OPERATOR_NAME), `contact${locale}.html: muestra el nombre real del operador (${OPERATOR_NAME}, sin traducir)`);
    ok(html.includes(ADDRESS_LINE_1) && html.includes(ADDRESS_LINE_2), `contact${locale}.html: muestra la dirección postal real completa`);
    ok(html.includes(COUNTRY_BY_LOCALE[locale]), `contact${locale}.html: país localizado ("${COUNTRY_BY_LOCALE[locale]}")`);
    ok(html.includes(REAL_EMAIL), `contact${locale}.html: muestra el email real`);
    ok(html.includes(REAL_PHONE), `contact${locale}.html: muestra el teléfono real`);
    // Integrado visualmente con el diseño existente: misma tarjeta (mismo
    // fondo/blur/borde/radio ya usado por "Información de Contacto" arriba)
    // envuelve el bloque de identidad, en vez de un bloque legal aislado.
    ok(/<section\s+style="background: rgba\(255, 255, 255, 0\.05\); backdrop-filter: blur\(10px\); border: 1px solid rgba\(224, 173, 97, 0\.2\); padding: 2rem; border-radius: 12px;[^"]*">\s*<h3[^>]*>LITUM3D<\/h3>/.test(html),
      `contact${locale}.html: el bloque de identidad usa la misma tarjeta visual que el resto de la página (no es un bloque feo/aislado)`);
  }
}

// =======================================================================
// 2) Terms ES/DE/FR: identificación del vendedor/operador, sin forma
//    societaria ni número fiscal inventado.
// =======================================================================
function checkTermsPagesIdentifySeller() {
  for (const locale of LOCALES) {
    const html = readView(`terms-conditions${locale}.html`);
    ok(html.includes(OPERATOR_NAME), `terms-conditions${locale}.html: identifica al operador real (${OPERATOR_NAME})`);
    ok(html.includes(ADDRESS_LINE_1) && html.includes(ADDRESS_LINE_2), `terms-conditions${locale}.html: dirección postal real completa`);
    ok(html.includes(COUNTRY_BY_LOCALE[locale]), `terms-conditions${locale}.html: país localizado ("${COUNTRY_BY_LOCALE[locale]}")`);
    ok(html.includes(REAL_EMAIL) && html.includes(REAL_PHONE), `terms-conditions${locale}.html: datos de contacto reales`);
  }
}

// =======================================================================
// 3) Privacy ES/DE/FR: responsable del tratamiento correcto.
// =======================================================================
function checkPrivacyPagesIdentifyController() {
  const CONTROLLER_LABEL = {
    '': 'Responsable del Tratamiento',
    '-de': 'Verantwortlicher für die Verarbeitung',
    '-fr': 'Responsable du Traitement'
  };
  for (const locale of LOCALES) {
    const html = readView(`privacy-policy${locale}.html`);
    ok(html.includes(CONTROLLER_LABEL[locale]), `privacy-policy${locale}.html: conserva el encabezado "${CONTROLLER_LABEL[locale]}"`);
    ok(html.includes(OPERATOR_NAME), `privacy-policy${locale}.html: identifica al responsable real (${OPERATOR_NAME})`);
    ok(html.includes(ADDRESS_LINE_1) && html.includes(ADDRESS_LINE_2), `privacy-policy${locale}.html: dirección postal real completa`);
    ok(html.includes(COUNTRY_BY_LOCALE[locale]), `privacy-policy${locale}.html: país localizado ("${COUNTRY_BY_LOCALE[locale]}")`);
  }
}

// =======================================================================
// 4) Ninguna página pública inventa forma societaria ni número fiscal/UID/
//    VAT -- LITUM3D es marca/nombre comercial, no una sociedad constituida.
// =======================================================================
function checkNoFabricatedCorporateFormOrTaxId() {
  for (const file of listPublicViews()) {
    const html = readView(file);
    ok(!/\bGmbH\b|\bAG\b|\bS\.?L\.?\b|\bSàrl\b|sociedad an[oó]nima|empresa registrada|Handelsregister|Registro Mercantil/i.test(html),
      `views/${file}: no afirma ninguna forma societaria (LITUM3D es marca comercial, no sociedad constituida)`);
    ok(!/\bUID-CHE|CHE-\d{3}\.\d{3}\.\d{3}|\bNIF\b|\bCIF\b|VAT[- ]?number|N[uú]mero fiscal|MWST-Nr|num[eé]ro de TVA/i.test(html),
      `views/${file}: no contiene ningún UID/NIF/CIF/número fiscal/VAT inventado`);
  }
}

// =======================================================================
// 5) La dirección real NO se filtra fuera de Contact/Terms/Privacy: el
//    footer global y el resto del sitio se mantienen limpios (informe,
//    sección 4 -- "no llenar todos los footers con la dirección completa").
// =======================================================================
function checkAddressNeverLeaksOutsideIdentityPages() {
  const approved = new Set();
  for (const page of IDENTITY_PAGES) {
    for (const locale of LOCALES) approved.add(`${page}${locale}.html`);
  }
  for (const file of listPublicViews()) {
    const html = readView(file);
    if (approved.has(file)) continue;
    ok(!html.includes(ADDRESS_LINE_1), `views/${file}: NO publica la dirección postal del operador (fuera de Contact/Terms/Privacy, footer limpio)`);
  }
}

// =======================================================================
// 6) ES/DE/FR: identidad/nombre/dirección nunca se traducen; solo la
//    etiqueta "operado por" y el nombre del país se localizan.
// =======================================================================
function checkIdentityNeverTranslatedOnlyLabelAndCountry() {
  for (const page of IDENTITY_PAGES) {
    for (const locale of LOCALES) {
      const html = readView(`${page}${locale}.html`);
      ok(html.includes(OPERATOR_NAME), `${page}${locale}.html: el nombre del operador se publica literal, sin traducir`);
      ok(html.includes(ADDRESS_LINE_1), `${page}${locale}.html: "Hauptstrasse 50" nunca se traduce/adapta por idioma`);
    }
  }
}

function main() {
  checkContactPagesShowOperatorIdentity();
  checkTermsPagesIdentifySeller();
  checkPrivacyPagesIdentifyController();
  checkNoFabricatedCorporateFormOrTaxId();
  checkAddressNeverLeaksOutsideIdentityPages();
  checkIdentityNeverTranslatedOnlyLabelAndCountry();

  console.log(`OK: ${checks} comprobaciones sobre la identificación legal del operador de LITUM3D (Contact/Terms/Privacy ES/DE/FR, sin forma societaria ni número fiscal inventado).`);
}

main();
