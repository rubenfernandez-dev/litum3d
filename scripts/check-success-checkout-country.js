/*
  LITUM3D - Test de regresión: teléfono en success.html/-fr/-de y país por
  defecto en el checkout.

  1) success.html/success-fr.html/success-de.html tenían el mismo teléfono
     español antiguo ("tel:+34600000000") que ya se corrigió en el footer de
     checkout (commit 95c5ed4) -- se sustituyó por el real vigente en todo
     el resto del sitio: +41 77 218 62 29 / tel:+41772186229.

  2) El <select name="customer_country"> de checkout-fr.html/checkout-de.html
     defaulteaba a España (ES); checkout.html (ES) ya forzaba CH mediante un
     <input type="hidden" value="CH">, sin selector visible. Auditoría del
     flujo completo (HTML -> public/js/checkout.js#getCustomerData ->
     services/checkout-payment.js#CUSTOMER_DATA_FIELDS ->
     services/checkout-finalization.js#CHECKOUT_COUNTRY_CODE) confirma que
     el valor del campo/select NUNCA se lee ni se envía: getCustomerData()
     hardcodea el literal 'CH' sin tocar el DOM, "country" se descarta antes
     de llegar al draft, y el backend persiste siempre la constante
     CHECKOUT_COUNTRY_CODE='CH' en pedidos.customer_country -- por eso
     cambiar cuál <option> lleva `selected` es un cambio puramente visual,
     sin impacto en envío/IVA/Stripe/contrato de backend (ninguno de esos
     lee jamás el valor real). Este test fija esa conclusión: si algún día
     el campo pasa a leerse de verdad, cualquier cambio de esa lógica debe
     venir acompañado de una revisión consciente de este test, no colarse
     sin darse cuenta.

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

  // ================= 2) checkout ES/FR/DE: CH es el país efectivo en las 3 =================
  // ES: input oculto, sin selector -- ya forzaba CH antes de esta tarea, se deja intacto.
  {
    const html = readFile('views/checkout.html');
    check(/<input type="hidden" name="customer_country" value="CH"\s*\/?>/.test(html), 'checkout.html (ES): customer_country sigue siendo el input oculto fijo a "CH" (sin cambios, ya era correcto)');
    check(!/España|Barcelona/.test(html), 'checkout.html (ES): no menciona España/Barcelona en ningún sitio');
  }

  // FR/DE: select visible con dos opciones (ES/CH); tras la corrección, CH
  // debe llevar `selected` y ES debe seguir existiendo como opción elegible
  // (el usuario puede cambiarlo manualmente; solo cambia el valor por defecto).
  const COUNTRY_SELECT_VIEWS = [
    { file: 'views/checkout-fr.html', esLabel: 'Espagne', chLabel: 'Suisse' },
    { file: 'views/checkout-de.html', esLabel: 'Spanien', chLabel: 'Schweiz' }
  ];
  for (const { file, esLabel, chLabel } of COUNTRY_SELECT_VIEWS) {
    const html = readFile(file);
    const selectMatch = html.match(/<select name="customer_country"[\s\S]*?<\/select>/);
    check(!!selectMatch, `${file}: conserva el <select name="customer_country"> (no se reescribió el formulario)`);
    const selectHtml = selectMatch[0];

    check(new RegExp(`<option value="CH" selected>${chLabel}</option>`).test(selectHtml), `${file}: la opción CH (${chLabel}) es la seleccionada por defecto`);
    check(new RegExp(`<option value="ES">${esLabel}</option>`).test(selectHtml), `${file}: la opción ES (${esLabel}) sigue existiendo y sigue siendo elegible por el usuario (solo cambió el default)`);
    check(!new RegExp(`<option value="ES" selected>`).test(selectHtml), `${file}: España ya NO es la opción seleccionada por defecto`);
    // Exactamente un `selected` en el select: nunca dos opciones marcadas a la vez.
    check((selectHtml.match(/\sselected\b/g) || []).length === 1, `${file}: hay exactamente una opción "selected" en el select (sin ambigüedad)`);
  }

  // ================= 2b) El valor del campo es cosmético: no lo lee ni lo envía nada =================
  // Fija la conclusión de la auditoría (ver cabecera): si esto deja de ser
  // cierto, es una señal de que el comportamiento real de envío/impuestos
  // podría empezar a depender del país mostrado, y este cambio de default
  // debería revisarse conscientemente en ese momento.
  {
    const checkoutJs = readFile('public/js/checkout.js');
    check(/country:\s*'CH'/.test(checkoutJs), "public/js/checkout.js#getCustomerData sigue hardcodeando country:'CH' (no lee el <select>/input real)");
    check(/const\s*\{\s*country,\s*\.\.\.\w+\s*\}\s*=\s*getCustomerData\(form\)/.test(checkoutJs), 'public/js/checkout.js sigue descartando "country" antes de enviar customerData al draft');

    const checkoutPaymentSrc = readFile('services/checkout-payment.js');
    check(/CUSTOMER_DATA_FIELDS\s*=\s*\[.*'zip'.*\]/.test(checkoutPaymentSrc) && !/CUSTOMER_DATA_FIELDS\s*=\s*\[[^\]]*'country'/.test(checkoutPaymentSrc), 'services/checkout-payment.js#CUSTOMER_DATA_FIELDS sigue sin admitir "country" (ticket #13)');

    const finalizationSrc = readFile('services/checkout-finalization.js');
    check(/CHECKOUT_COUNTRY_CODE\s*=\s*'CH'/.test(finalizationSrc), "services/checkout-finalization.js sigue persistiendo el país del pedido con la constante server-controlled CHECKOUT_COUNTRY_CODE='CH', independiente del formulario");
  }

  console.log(`OK: ${checks} comprobaciones sobre el teléfono de success y el país por defecto de checkout.`);
}

main();
