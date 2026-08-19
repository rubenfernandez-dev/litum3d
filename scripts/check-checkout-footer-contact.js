/*
  LITUM3D - Test de regresión: footer de contacto de /checkout.

  El footer de checkout.html/checkout-fr.html/checkout-de.html tenía datos
  de contacto antiguos (España: "+34 123 456 789" / "Barcelona, ...") que
  ya no corresponden al negocio real -- el resto del sitio (index/shop/
  about/contact/cart/gallery, ES/DE/FR) usa "+41 77 218 62 29" / "Berna,
  Suiza" (Bern, Suiza) desde antes. No hay motor de plantillas ni parcial
  compartido (cada view/*.html es HTML estático independiente), así que
  la corrección se hizo por archivo -- este test evita que los 3 footers
  de checkout vuelvan a divergir del resto del sitio.

  No se comprueba la ausencia de "España"/"Espagne"/"Spanien" a secas: el
  <select name="customer_country"> del propio formulario de checkout
  incluye legítimamente España como país de envío (fuera de alcance de
  esta corrección, es lógica del formulario, no el footer de contacto) --
  ese literal seguiría dando positivo y generaría un falso fallo.

  Uso: node scripts/check-checkout-footer-contact.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readView(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'views', name), 'utf8');
}

let checks = 0;
function check(condition, message) {
  checks++;
  assert.ok(condition, message);
}

const REAL_PHONE = '+41 77 218 62 29';
const REAL_EMAIL = 'contact@litum3d.com';

const CHECKOUT_VIEWS = [
  { file: 'checkout.html', city: 'Berna, Suiza' },
  { file: 'checkout-fr.html', city: 'Berne, Suisse' },
  { file: 'checkout-de.html', city: 'Bern, Schweiz' }
];

function main() {
  for (const { file, city } of CHECKOUT_VIEWS) {
    const html = readView(file);

    // --- Datos antiguos de España: ausentes ---
    check(!/\+34/.test(html), `views/${file}: no debe contener ningún teléfono "+34" (dato antiguo de España)`);
    check(!/Barcelona/i.test(html), `views/${file}: no debe mencionar "Barcelona" (dato antiguo de España)`);

    // --- Datos reales (los mismos que el resto del sitio): presentes en el footer ---
    check(html.includes(REAL_PHONE), `views/${file}: el footer debe mostrar el teléfono real ${REAL_PHONE}`);
    check(html.includes(city), `views/${file}: el footer debe mostrar la ubicación real "${city}"`);
    check(html.includes(REAL_EMAIL), `views/${file}: el footer conserva el email real ${REAL_EMAIL} (no se tocó, ya era correcto)`);

    // --- La corrección vive en la sección de contacto del footer, no en cualquier parte de la página ---
    const contactSectionMatch = html.match(/<div class="footer-section">\s*<h4>(?:Contacto|Contact|Kontakt)<\/h4>[\s\S]*?<\/div>/);
    check(!!contactSectionMatch, `views/${file}: existe una sección "Contacto/Contact/Kontakt" en el footer`);
    if (contactSectionMatch) {
      check(contactSectionMatch[0].includes(REAL_PHONE), `views/${file}: el teléfono real está DENTRO de la sección de contacto del footer, no en otro sitio`);
      check(contactSectionMatch[0].includes(city), `views/${file}: la ubicación real está DENTRO de la sección de contacto del footer, no en otro sitio`);
    }
  }

  console.log(`OK: ${checks} comprobaciones sobre el footer de contacto de /checkout (ES/FR/DE).`);
}

main();
