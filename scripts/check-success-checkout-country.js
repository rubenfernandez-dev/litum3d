/*
  LITUM3D - Test de regresión: teléfono en success.html/-fr/-de y selector
  de país del checkout.

  1) success.html/success-fr.html/success-de.html tenían el mismo teléfono
     español antiguo ("tel:+34600000000") que ya se corrigió en el footer de
     checkout (commit 95c5ed4) -- se sustituyó por el real vigente en todo
     el resto del sitio: +41 77 218 62 29 / tel:+41772186229.

  2) Saneamiento de país (informe correspondiente): hasta este cambio, el
     <select name="customer_country"> de checkout-fr.html/checkout-de.html
     defaulteaba a España y checkout.html (ES) forzaba CH mediante un
     <input type="hidden">, sin selector visible -- y en cualquier caso el
     valor NUNCA se leía ni se enviaba (getCustomerData() hardcodeaba 'CH',
     el backend lo descartaba). Ahora los tres locales ofrecen un <select>
     real con los mismos seis países (ES/PT/FR/CH/DE/IT), SIN ninguna
     opción preseleccionada (placeholder vacío/disabled/required, ver
     views/checkout*.html), y el valor elegido viaja de verdad hasta
     customerData.country -> checkout_drafts -> pedidos.customer_country
     (ver services/checkout-drafts.js#validateCustomerData contra la
     allowlist de config/checkout-countries.js). Este test fija esa
     arquitectura: el idioma de la página nunca decide el país.

  Uso: node scripts/check-success-checkout-country.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readFile(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

let checks = 0;
function check(condition, message) {
  checks++;
  assert.ok(condition, message);
}

const REAL_PHONE = '+41 77 218 62 29';
const REAL_TEL_HREF = 'tel:+41772186229';

function main() {
  // ================= 1) success.html/-fr/-de: teléfono real, sin +34 =================
  const SUCCESS_VIEWS = ['views/success.html', 'views/success-fr.html', 'views/success-de.html'];
  for (const view of SUCCESS_VIEWS) {
    const html = readFile(view);
    check(!/\+34/.test(html), `${view}: no debe contener ningún teléfono "+34" (dato antiguo de España)`);
    check(html.includes(REAL_TEL_HREF), `${view}: el enlace tel: debe usar el formato real ${REAL_TEL_HREF}`);
    check(html.includes(REAL_PHONE), `${view}: el texto visible del teléfono debe ser ${REAL_PHONE}`);
    check(new RegExp(`<a href="${REAL_TEL_HREF.replace('+', '\\+')}">${REAL_PHONE.replace('+', '\\+')}</a>`).test(html), `${view}: href y texto visible del teléfono están en el mismo enlace (no repartidos/desincronizados)`);
  }

  // ================= 2) checkout ES/DE/FR: mismos 6 países, sin default =================
  const ALLOWED = require('../config/checkout-countries').ALLOWED_CHECKOUT_COUNTRIES;
  const COUNTRY_SELECT_VIEWS = [
    { file: 'views/checkout.html', placeholder: 'Selecciona tu país', labels: { ES: 'España', PT: 'Portugal', FR: 'Francia', CH: 'Suiza', DE: 'Alemania', IT: 'Italia' } },
    { file: 'views/checkout-fr.html', placeholder: 'Sélectionnez votre pays', labels: { ES: 'Espagne', PT: 'Portugal', FR: 'France', CH: 'Suisse', DE: 'Allemagne', IT: 'Italie' } },
    { file: 'views/checkout-de.html', placeholder: 'Land auswählen', labels: { ES: 'Spanien', PT: 'Portugal', FR: 'Frankreich', CH: 'Schweiz', DE: 'Deutschland', IT: 'Italien' } }
  ];

  for (const { file, placeholder, labels } of COUNTRY_SELECT_VIEWS) {
    const html = readFile(file);

    // checkout.html (ES) ya NO tiene el input oculto fijo a CH: ahora es un
    // <select> real, igual que DE/FR (sección 3 del informe de país).
    check(!/<input type="hidden" name="customer_country"/.test(html), `${file}: customer_country ya NO es un input oculto (ahora es un <select> real)`);

    const selectMatch = html.match(/<select name="customer_country"[\s\S]*?<\/select>/);
    check(!!selectMatch, `${file}: existe un <select name="customer_country" required>`);
    const selectHtml = selectMatch[0];
    check(/required/.test(selectHtml), `${file}: el <select> de país es required`);

    // Placeholder vacío, disabled y preseleccionado -- el usuario debe elegir explícitamente.
    check(new RegExp(`<option value="" selected disabled>${placeholder}</option>`).test(selectHtml), `${file}: existe el placeholder vacío/disabled/selected "${placeholder}"`);

    // Exactamente los 6 códigos de la allowlist canónica, en el mismo orden, y NINGUNO preseleccionado.
    for (const code of ALLOWED) {
      const label = labels[code];
      check(new RegExp(`<option value="${code}">${label}</option>`).test(selectHtml), `${file}: ofrece <option value="${code}">${label}</option>`);
      check(!new RegExp(`<option value="${code}" selected>`).test(selectHtml), `${file}: la opción ${code} NO lleva "selected" (el usuario debe elegir)`);
    }
    const optionCount = (selectHtml.match(/<option value="[A-Z]{2}">/g) || []).length;
    check(optionCount === ALLOWED.length, `${file}: hay exactamente ${ALLOWED.length} países reales (sin países fuera de ES/PT/FR/CH/DE/IT)`);

    // Solo la opción placeholder lleva `selected` (nunca un país real).
    const selectedCount = (selectHtml.match(/\sselected\b/g) || []).length;
    check(selectedCount === 1, `${file}: hay exactamente un "selected" en el select (el placeholder vacío, ningún país)`);
  }

  // Los 3 locales ofrecen EXACTAMENTE los mismos 6 códigos (mismo orden, solo cambia el idioma del label).
  {
    const extractCodes = (html) => (html.match(/<option value="([A-Z]{2})">/g) || []).map(m => m.match(/"([A-Z]{2})"/)[1]);
    const codesByLocale = COUNTRY_SELECT_VIEWS.map(({ file }) => extractCodes(readFile(file).match(/<select name="customer_country"[\s\S]*?<\/select>/)[0]));
    const [esCodesOrder, frCodesOrder, deCodesOrder] = codesByLocale;
    check(JSON.stringify(esCodesOrder) === JSON.stringify(ALLOWED), 'checkout.html: el orden/códigos coincide EXACTAMENTE con config/checkout-countries.js');
    check(JSON.stringify(frCodesOrder) === JSON.stringify(esCodesOrder), 'checkout-fr.html ofrece exactamente los mismos códigos, en el mismo orden, que checkout.html (ES)');
    check(JSON.stringify(deCodesOrder) === JSON.stringify(esCodesOrder), 'checkout-de.html ofrece exactamente los mismos códigos, en el mismo orden, que checkout.html (ES)');
  }

  // ================= 2b) El país ahora SÍ viaja hasta el pedido (ya no es cosmético) =================
  // Fija la nueva arquitectura: si algún día vuelve a hardcodearse o a
  // descartarse, esta comprobación debe fallar y forzar una revisión
  // consciente, igual que antes fijaba lo contrario.
  {
    const checkoutJs = readFile('public/js/checkout.js');
    check(!/country:\s*'CH'/.test(checkoutJs), "public/js/checkout.js#getCustomerData ya NO hardcodea country:'CH'");
    check(/country:\s*form\?\.customer_country\?\.value/.test(checkoutJs), 'public/js/checkout.js#getCustomerData lee customer_country del DOM real');
    check(!/const\s*\{\s*country,\s*\.\.\.\w+\s*\}\s*=\s*getCustomerData\(form\)/.test(checkoutJs), 'public/js/checkout.js ya NO descarta "country" antes de enviar customerData al draft');

    const checkoutPaymentSrc = readFile('services/checkout-payment.js');
    check(/CUSTOMER_DATA_FIELDS\s*=\s*\[[^\]]*'country'[^\]]*\]/.test(checkoutPaymentSrc), 'services/checkout-payment.js#CUSTOMER_DATA_FIELDS ya admite "country"');

    const checkoutDraftsSrc = readFile('services/checkout-drafts.js');
    check(/CUSTOMER_DATA_FIELDS\s*=\s*\[[^\]]*'country'[^\]]*\]/.test(checkoutDraftsSrc), 'services/checkout-drafts.js#CUSTOMER_DATA_FIELDS (validación real, PATCH) ya admite "country"');
    check(/isAllowedCheckoutCountry\(normalized\.country\)/.test(checkoutDraftsSrc), 'services/checkout-drafts.js#validateCustomerData valida country contra la allowlist canónica, no confía en el frontend');

    const finalizationSrc = readFile('services/checkout-finalization.js');
    check(!/CHECKOUT_COUNTRY_CODE/.test(finalizationSrc), 'services/checkout-finalization.js ya NO contiene ninguna constante de país forzado');
    check(/customerData\?\.country \|\| null/.test(finalizationSrc), 'services/checkout-finalization.js persiste customerData.country (con NULL explícito para drafts legacy, nunca CH asumido)');
  }

  console.log(`OK: ${checks} comprobaciones sobre el teléfono de success y el país por defecto de checkout.`);
}

main();
