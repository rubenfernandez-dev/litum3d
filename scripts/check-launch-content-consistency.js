/*
  LITUM3D - Test de regresión: CHECKLIST FINAL de contenido/UX previa a
  lanzamiento (informe "checklist final conjunta").

  Cubre EXCLUSIVAMENTE lo que esta tarea cambió -- alineación de contenido
  con el estado de negocio confirmado (FDM, 8 años, horario L-V 9-18h,
  plazo 3-6 días laborables), retirada de newsletter/redes sociales
  inactivas, y guardas de que NADA fiscal/societario se tocó ni se inventó.

  Uso: node scripts/check-launch-content-consistency.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }

const ROOT = path.join(__dirname, '..');
const VIEWS_DIR = path.join(ROOT, 'views');
function readView(name) { return fs.readFileSync(path.join(VIEWS_DIR, name), 'utf8'); }
function readFile(relPath) { return fs.readFileSync(path.join(ROOT, relPath), 'utf8'); }

function listPublicViews() {
  return fs.readdirSync(VIEWS_DIR).filter(f =>
    f.endsWith('.html') && !f.startsWith('admin-') && f !== '404.html'
  );
}

// =======================================================================
// 1) FDM/SLA: ninguna página pública menciona ya "SLA" como tecnología
// =======================================================================
function checkNoSlaAnywhere() {
  for (const file of listPublicViews()) {
    const html = readView(file);
    ok(!/\bSLA\b/.test(html), `views/${file}: no debe mencionar "SLA" (la tecnología real es FDM)`);
  }
}

function checkFdmMentionedInKeyFamilies() {
  const FDM_FAMILIES = ['about', 'cart', 'checkout', 'contact', 'gallery'];
  for (const family of FDM_FAMILIES) {
    for (const suffix of ['', '-de', '-fr']) {
      const file = `${family}${suffix}.html`;
      const html = readView(file);
      ok(/FDM/.test(html), `views/${file}: menciona FDM (tecnología real) en la sección de footer/beneficios`);
    }
  }
}

// =======================================================================
// 2) Experiencia: 8 años coherente, sin "7+" referido a experiencia
// =======================================================================
function checkExperienceYearsCoherent() {
  for (const file of listPublicViews()) {
    const html = readView(file);
    ok(!/7\+\s*años|7\+\s*ans|über 7 Jahren|plus de 7 ans|más de 7 años/i.test(html),
      `views/${file}: no debe afirmar 7+/7 años de experiencia (la cifra real es 8)`);
  }
  for (const [file, pattern] of [
    ['about.html', /8 años de experiencia/],
    ['about-de.html', /über 8 Jahren Erfahrung/],
    ['about-fr.html', /plus de 8 ans d'expérience/]
  ]) {
    ok(pattern.test(readView(file)), `views/${file}: afirma 8 años de experiencia de forma coherente`);
  }
}

// =======================================================================
// 3) Horario: sin 24/7 de atención humana; L-V 9:00-18:00 coherente
// =======================================================================
function checkNoFakeHumanAvailability247() {
  for (const file of listPublicViews()) {
    const html = readView(file);
    // "24 horas"/"24h" legítimos (reserva de carrito, cookies) no son
    // atención al cliente -- solo se prohíbe el patrón "24/7" pegado a un
    // texto de atención al cliente, ya localizado y corregido en about*.
    ok(!/(atención al cliente|kundenservice|service client)[^<]{0,40}24\/7/i.test(html),
      `views/${file}: no debe afirmar atención al cliente 24/7`);
  }
  const HOURS = [
    ['about.html', /L-V 9:00-18:00/],
    ['about-de.html', /Mo-Fr 9:00-18:00/],
    ['about-fr.html', /Lun-Ven 9:00-18:00/]
  ];
  for (const [file, pattern] of HOURS) {
    ok(pattern.test(readView(file)), `views/${file}: horario real L-V 9:00-18:00 (o equivalente) coherente`);
  }
}

// =======================================================================
// 4) Newsletter: sin bloque visible ni confirmación falsa
// =======================================================================
function checkNoNewsletterBlockAnywhere() {
  for (const file of listPublicViews()) {
    const html = readView(file);
    ok(!/newsletter/i.test(html) || file.startsWith('privacy-policy'),
      `views/${file}: sin bloque de newsletter visible (privacy-policy conserva solo texto legal abstracto, sin formulario)`);
    ok(!/newsletter-form|subscribeNewsletter/i.test(html), `views/${file}: sin formulario ni handler de newsletter`);
  }
  // La mención textual que privacy-policy conserva es solo la cláusula legal
  // abstracta (qué pasaría SI existiera newsletter), nunca un <form> real.
  for (const suffix of ['', '-de', '-fr']) {
    const html = readView(`privacy-policy${suffix}.html`);
    ok(!/<form/i.test(html), `views/privacy-policy${suffix}.html: no contiene ningún <form> (la mención de newsletter es solo texto legal)`);
  }
}

function checkNewsletterDeadCodeRemoved() {
  const homeJs = readFile('public/js/home.js');
  ok(!/subscribeNewsletter/.test(homeJs), 'public/js/home.js: subscribeNewsletter() eliminado (quedó sin uso tras retirar el markup)');
  ok(!/newsletter_subscribers/.test(homeJs), 'public/js/home.js: sin referencias residuales a localStorage de newsletter');
}

// =======================================================================
// 5) Redes sociales: sin href="#" de iconos sociales retirados
// =======================================================================
function checkNoRemovedSocialHrefHash() {
  for (const file of listPublicViews()) {
    const html = readView(file);
    ok(!/footer-socials|social-links/.test(html), `views/${file}: sin bloque de redes sociales (cuentas aún no existen)`);
  }
  // success.html conserva un href="#" preexistente y NO relacionado (enlaces
  // legales rotos, hallazgo reportado aparte, fuera de alcance de esta
  // tarea) -- se excluye explícitamente de la prohibición general para no
  // dar una falsa sensación de cobertura sobre un bug distinto.
  const KNOWN_UNRELATED_HASH_LINKS = { 'success.html': 2 };
  for (const file of listPublicViews()) {
    const html = readView(file);
    const hashLinks = (html.match(/href="#"/g) || []).length;
    const allowed = KNOWN_UNRELATED_HASH_LINKS[file] || 0;
    ok(hashLinks <= allowed, `views/${file}: sin href="#" nuevos de redes sociales (encontrados ${hashLinks}, permitidos ${allowed} ya reportados aparte)`);
  }
}

// =======================================================================
// 6) Identidad: no se ha añadido ninguna forma societaria/UID/NIF ficticia
// =======================================================================
function checkNoFabricatedLegalIdentity() {
  const LEGAL_AND_FOOTERS = listPublicViews();
  for (const file of LEGAL_AND_FOOTERS) {
    const html = readView(file);
    ok(!/\bGmbH\b|\bAG\b|\bS\.?L\.?\b|\bSàrl\b|sociedad an[oó]nima|empresa registrada|Handelsregister/i.test(html),
      `views/${file}: no afirma ninguna forma societaria (no existe sociedad constituida)`);
    ok(!/\bUID-CHE|CHE-\d{3}\.\d{3}\.\d{3}|\bNIF\b|\bCIF\b|VAT[- ]?number/i.test(html),
      `views/${file}: no contiene ningún UID/NIF/CIF/VAT number inventado`);
    ok(!/Hauptstrasse 50/i.test(html), `views/${file}: no publica la dirección no aprobada`);
  }
}

// =======================================================================
// 7) Teléfono: solo el número suizo real, sin placeholders antiguos
// =======================================================================
function checkOnlyRealSwissPhone() {
  for (const file of listPublicViews()) {
    const html = readView(file);
    ok(!/\+34/.test(html), `views/${file}: sin número español antiguo/placeholder`);
  }
}

// =======================================================================
// 8) Guardas fiscales/pricing/checkout: NADA de esto se ha tocado aquí
// =======================================================================
function checkFiscalAndCheckoutUntouched() {
  const pricingConfig = require('../config/pricing');
  ok(pricingConfig.VAT_PERCENT === 21, 'config/pricing.js: VAT_PERCENT sigue siendo 21 -- el cambio fiscal NO se aplica en esta tarea, solo se propuso');
  ok(pricingConfig.currency === 'eur', "config/pricing.js: currency sigue siendo 'eur'");

  const { ALLOWED_CHECKOUT_COUNTRIES } = require('../config/checkout-countries');
  assert.deepStrictEqual([...ALLOWED_CHECKOUT_COUNTRIES], ['ES', 'PT', 'FR', 'CH', 'DE', 'IT'], 'config/checkout-countries.js: allowlist de países intacta');
  checks++;

  // Los textos "IVA (21%)" siguen ahí a propósito (no se aplicó el cambio
  // fiscal): esto es una comprobación de que NO se tocó, no de que esté bien.
  ok(/IVA \(21%\)/.test(readView('terms-conditions.html')), 'terms-conditions.html: "IVA (21%)" sigue intacto (cambio fiscal NO aplicado en esta tarea)');
}

function main() {
  checkNoSlaAnywhere();
  checkFdmMentionedInKeyFamilies();
  checkExperienceYearsCoherent();
  checkNoFakeHumanAvailability247();
  checkNoNewsletterBlockAnywhere();
  checkNewsletterDeadCodeRemoved();
  checkNoRemovedSocialHrefHash();
  checkNoFabricatedLegalIdentity();
  checkOnlyRealSwissPhone();
  checkFiscalAndCheckoutUntouched();

  console.log(`OK: ${checks} comprobaciones de la checklist final de contenido/UX de lanzamiento.`);
}

main();
