/*
  LITUM3D - Test de regresión: profesionalización del sistema de emails
  transaccionales y de soporte (informe "profesionalizar TODO el sistema de
  emails").

  Cubre: capa visual única (services/email-template.js), los 3 builders de
  email de pedidos (services/order-emails.js), el transporte/FROM
  compartido (services/mailer.js), y el cableado de Reply-To/escape en
  routes/payments.js, routes/admin.js y routes/contact.js. NO toca red real
  ni BD: todo se ejercita en memoria sobre las funciones puras exportadas, o
  mediante inspección del código fuente para invariantes de cableado
  (Reply-To, ausencia de plantillas duplicadas, ausencia de IVA).

  Uso: node scripts/check-email-branding.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); checks++; }

const ROOT = path.join(__dirname, '..');
function readFile(relPath) { return fs.readFileSync(path.join(ROOT, relPath), 'utf8'); }

const emailTemplate = require('../services/email-template');
const orderEmails = require('../services/order-emails');
const mailer = require('../services/mailer');

const NO_VAT_PATTERN = /IVA\s*\(?21|VAT\s*\(?21|MwSt\.?\s*\(?21|TVA\s*\(?21|21\s*%|\/\s*1\.21|Base\s*\(sin IVA\)/i;

// =======================================================================
// 1) Branding real: logo HTTPS absoluto, colores reales del sitio
// =======================================================================
function checkBrandingUsesRealAssets() {
  const logoUrl = emailTemplate.getLogoUrl();
  ok(logoUrl.startsWith('https://'), `getLogoUrl() produce una URL HTTPS absoluta (no relativa): ${logoUrl}`);
  ok(!logoUrl.startsWith('/'), 'getLogoUrl() nunca empieza por "/" (una ruta relativa no carga en un cliente de email)');
  ok(logoUrl.includes('/img/logos/lineal.logo.png'), 'getLogoUrl() reutiliza el logo REAL ya servido en el header público del sitio');

  const logoFileOnDisk = path.join(ROOT, 'public', 'img', 'logos', 'lineal.logo.png');
  ok(fs.existsSync(logoFileOnDisk), 'el archivo del logo referenciado existe realmente en public/img/logos/');

  // Colores reales del sitio (public/css/styles.css --primary/--gold), no inventados.
  const stylesCss = readFile('public/css/styles.css');
  ok(stylesCss.includes(emailTemplate.BRAND.primary), `BRAND.primary (${emailTemplate.BRAND.primary}) es el mismo --primary real de public/css/styles.css`);
  ok(stylesCss.includes(emailTemplate.BRAND.gold), `BRAND.gold (${emailTemplate.BRAND.gold}) es el mismo --gold real de public/css/styles.css`);

  // Sin dependencias externas prohibidas (sección 5): sin Google Fonts, sin JS.
  ok(!/fonts\.googleapis\.com/.test(emailTemplate.BRAND.fontFamily), 'la tipografía del email no depende de Google Fonts');
}

// =======================================================================
// 2) Soporte: datos públicos reales (contact@litum3d.com / +41 77 218 62 29)
// =======================================================================
function checkSupportInfoMatchesRealPublicData() {
  eq(emailTemplate.SUPPORT_INFO.email, 'contact@litum3d.com', 'SUPPORT_INFO.email es el email público real de LITUM3D');
  eq(emailTemplate.SUPPORT_INFO.phone, '+41 77 218 62 29', 'SUPPORT_INFO.phone es el teléfono público real de LITUM3D');

  // Mismos datos que ya se publican en el footer real del checkout (no inventados aquí).
  const checkoutHtml = readFile('views/checkout.html');
  ok(checkoutHtml.includes(emailTemplate.SUPPORT_INFO.email), 'el email de soporte del template coincide con el ya publicado en views/checkout.html');
  ok(checkoutHtml.includes('+41 77 218 62 29'), 'el teléfono de soporte del template coincide con el ya publicado en views/checkout.html');
}

// =======================================================================
// 3) Footer: URLs legales absolutas, por idioma, coherentes con routes/index.js
// =======================================================================
function checkFooterLegalLinksAreAbsoluteAndLocalized() {
  for (const locale of ['es', 'de', 'fr']) {
    const { html, text } = emailTemplate.renderLitumEmail({ locale, title: 'T', contentHtml: '<p>x</p>', contentText: 'x' });
    const paths = emailTemplate.LEGAL_PATHS[locale];
    const baseUrl = emailTemplate.getBaseUrl();
    for (const key of ['privacy', 'terms', 'contact']) {
      const absoluteUrl = `${baseUrl}${paths[key]}`;
      ok(html.includes(`href="${absoluteUrl}"`), `footer HTML (${locale}): enlace ${key} es absoluto (${absoluteUrl})`);
      ok(text.includes(absoluteUrl), `footer text (${locale}): incluye la URL absoluta de ${key}`);
    }
  }
}

// =======================================================================
// 4) Bloque de soporte: presente con orderId, ausente si showSupport=false
// =======================================================================
function checkSupportBlockToggle() {
  const withOrder = emailTemplate.renderLitumEmail({ locale: 'es', title: 'T', contentHtml: '<p>x</p>', contentText: 'x', orderId: 4242 });
  ok(withOrder.html.includes('¿Necesitas ayuda con este pedido?'), 'con orderId, el bloque de soporte (título ES) aparece en HTML');
  ok(withOrder.html.includes('#4242'), 'el bloque de soporte incluye la referencia #pedido');
  ok(withOrder.html.includes(emailTemplate.SUPPORT_INFO.email) && withOrder.html.includes(emailTemplate.SUPPORT_INFO.phone), 'el bloque de soporte muestra email y teléfono reales');
  ok(withOrder.text.includes('#4242') && withOrder.text.includes(emailTemplate.SUPPORT_INFO.email), 'la versión text también incluye la referencia y el email de soporte');

  const withoutSupport = emailTemplate.renderLitumEmail({ locale: 'es', title: 'T', contentHtml: '<p>x</p>', contentText: 'x', orderId: 4242, showSupport: false });
  ok(!withoutSupport.html.includes('¿Necesitas ayuda con este pedido?'), 'showSupport:false suprime el bloque de soporte (email interno de Admin)');
}

// =======================================================================
// 5) Escape HTML: nombre/dirección/notas maliciosos nunca se interpretan
// =======================================================================
function checkHtmlEscaping() {
  const evilName = '<script>alert(1)</script>';
  const { subject, html, text } = orderEmails.buildOrderConfirmationEmail({
    locale: 'es',
    orderId: 77,
    orderDate: new Date('2026-01-15T10:00:00Z'),
    customerData: { name: evilName, email: 'a@b.com', phone: '123', address: '<img src=x onerror=alert(2)>', city: 'C', zip: '1', country: 'ES' },
    items: [{ productName: '<b>Prod</b>', modelName: null, variantSelections: [], extras: {}, quantity: 1, unitPriceCents: 1000 }],
    totals: { shippingCents: 0, totalCents: 1000 },
    currency: 'eur'
  });
  ok(!html.includes('<script>alert(1)</script>'), 'el nombre del cliente nunca se inserta como HTML sin escapar (sin <script> literal)');
  ok(html.includes('&lt;script&gt;'), 'el nombre del cliente aparece escapado (&lt;script&gt;)');
  ok(!html.includes('<img src=x onerror=alert(2)>'), 'la dirección nunca se inserta como HTML sin escapar');
  ok(!html.includes('<b>Prod</b>'), 'el nombre de producto nunca se inserta como HTML sin escapar');
  ok(subject.includes('#77'), 'sanity: el subject de esta prueba referencia el pedido');
  void text;
}

// =======================================================================
// 6) Confirmación de pedido (cliente): subject, contenido, sin IVA
// =======================================================================
function checkOrderConfirmationEmail() {
  const SUBJECTS = {
    es: '[LITUM3D #501] Confirmación de pedido',
    de: '[LITUM3D #501] Bestellbestätigung',
    fr: '[LITUM3D #501] Confirmation de commande'
  };
  const customerData = { name: 'Ruben Fernandez', email: 'ruben@example.com', phone: '+41791234567', address: 'Bahnhofstrasse 1', city: 'Bern', zip: '3000', country: 'CH' };
  const items = [
    { productName: 'Litofanía Circular', modelName: 'Modelo Redondo', variantSelections: [{ variantTypeName: 'Base', optionName: 'Madera' }], extras: { upscale: true, qr: true, qrMessage: 'Te quiero', adapter: true }, quantity: 2, unitPriceCents: 7095, notes: 'Centrar la cara' }
  ];
  const totals = { shippingCents: 0, totalCents: 14190 };

  for (const locale of ['es', 'de', 'fr']) {
    const result = orderEmails.buildOrderConfirmationEmail({ locale, orderId: 501, orderDate: new Date('2026-03-01T12:00:00Z'), customerData, items, totals, currency: 'eur' });
    eq(result.subject, SUBJECTS[locale], `confirmación (${locale}): subject exacto con #pedido`);
    ok(result.subject.includes('#501'), `confirmación (${locale}): subject incluye la referencia #pedido`);
    ok(!NO_VAT_PATTERN.test(result.html) && !NO_VAT_PATTERN.test(result.text), `confirmación (${locale}): CERO desglose "IVA 21%"/1.21 en html/text`);
    ok(result.html.includes('141,90') || result.html.includes('141,90 €'), `confirmación (${locale}): TOTAL mostrado es exactamente el importe recibido (14190 cents), sin recalcular`);
    ok(result.html.includes('Madera'), `confirmación (${locale}): muestra la variante seleccionada (Base: Madera)`);
    ok(result.html.includes('Upscale'), `confirmación (${locale}): muestra los extras seleccionados`);
    ok(result.html.includes('Gratis') || result.html.includes('Kostenlos') || result.html.includes('Gratuite'), `confirmación (${locale}): envío se muestra como gratis (shippingCents=0), nunca inventado`);
    ok(result.text.length > 0 && result.text.includes('501'), `confirmación (${locale}): existe versión text con la referencia del pedido`);
    ok(result.html.includes(customerData.address), `confirmación (${locale}): dirección de envío real presente`);
  }
}

// =======================================================================
// 7) Nuevo pedido (Admin): siempre ES, país visible, sin datos internos de más
// =======================================================================
function checkAdminNewOrderEmail() {
  const customerData = { name: 'Ruben Fernandez', email: 'ruben@example.com', phone: '+41791234567', address: 'Bahnhofstrasse 1', city: 'Bern', zip: '3000', country: 'CH' };
  const items = [{ productName: 'Litofanía Circular', modelName: null, variantSelections: [], extras: {}, quantity: 1, unitPriceCents: 4995 }];
  const totals = { shippingCents: 0, totalCents: 4995 };

  const withPhotos = orderEmails.buildAdminNewOrderEmail({ orderId: 502, orderDate: new Date(), customerData, items, totals, currency: 'eur', hasPhotos: true });
  ok(withPhotos.subject.includes('#502') && withPhotos.subject.includes('Ruben Fernandez'), 'admin: subject identifica #pedido y cliente');
  ok(withPhotos.html.includes(customerData.email), 'admin: email del cliente visible para identificación rápida');
  ok(withPhotos.html.includes(customerData.phone), 'admin: teléfono del cliente visible');
  ok(withPhotos.html.includes('CH'), 'admin: país del cliente visible (identificación rápida, sección 8)');
  ok(withPhotos.html.includes('/admin'), 'admin: incluye enlace al panel Admin cuando hay fotos');
  ok(!NO_VAT_PATTERN.test(withPhotos.html) && !NO_VAT_PATTERN.test(withPhotos.text), 'admin: CERO desglose de IVA');
  ok(!withPhotos.html.includes('¿Necesitas ayuda con este pedido?'), 'admin: sin bloque de soporte al cliente (email interno)');
  ok(!/DEBUG/.test(withPhotos.html), 'admin: sin bloque DEBUG interno innecesario (limpieza sección 8)');

  const withoutPhotos = orderEmails.buildAdminNewOrderEmail({ orderId: 503, orderDate: new Date(), customerData, items, totals, currency: 'eur', hasPhotos: false });
  ok(!withoutPhotos.html.includes('/admin'), 'admin: sin enlace al panel cuando no hay fotos que ver');
}

// =======================================================================
// 8) Cambio de estado: subject/mensaje por idioma, fallback desconocido
// =======================================================================
function checkStatusChangeEmail() {
  const SUBJECTS = {
    es: '[LITUM3D #900] Actualización de tu pedido',
    de: '[LITUM3D #900] Aktualisierung deiner Bestellung',
    fr: '[LITUM3D #900] Mise à jour de votre commande'
  };
  for (const locale of ['es', 'de', 'fr']) {
    const result = orderEmails.buildStatusChangeEmail({ locale, orderId: 900, customerName: 'Ana', newStatus: 'Enviado' });
    eq(result.subject, SUBJECTS[locale], `cambio de estado (${locale}): subject exacto con #pedido`);
    ok(!NO_VAT_PATTERN.test(result.html), `cambio de estado (${locale}): sin IVA`);
    ok(result.html.includes('#900'), `cambio de estado (${locale}): referencia de pedido visible`);
    ok(result.html.includes('¿Necesitas ayuda con este pedido?') || result.html.includes('Brauchst du Hilfe') || result.html.includes('Besoin d’aide'), `cambio de estado (${locale}): bloque de soporte presente`);
  }

  const unknown = orderEmails.buildStatusChangeEmail({ locale: 'es', orderId: 901, customerName: 'Ana', newStatus: 'EstadoInventado' });
  ok(unknown.html.includes('actualizado'), 'cambio de estado: fallback coherente para un estado no mapeado, nunca vacío ni roto');
}

// =======================================================================
// 9) Fallback de locale: los call-sites reales NUNCA infieren el idioma
//    del país -- pasan 'es' explícito (sección 12 del informe)
// =======================================================================
// Nota: el locale YA se persiste (informe "persistir locale del
// comprador", ver scripts/check-email-locale-persistence.js para la
// cobertura completa del flujo checkout->draft->email). Esta comprobación
// solo verifica el invariante de seguridad que sigue vigente: el locale
// nunca se deriva de customerData.country.
function checkLocaleNeverInferredFromCountry() {
  const paymentsSrc = readFile('routes/payments.js');
  const adminSrc = readFile('routes/admin.js');
  ok(/locale:\s*customerData\.locale/.test(paymentsSrc), 'routes/payments.js: el email de confirmación usa el locale persistido en customerData (no un valor fijo)');
  ok(!/customerData\.country[\s\S]{0,60}locale/.test(paymentsSrc) && !/locale[\s\S]{0,60}customerData\.country/.test(paymentsSrc),
    'routes/payments.js: el locale del email nunca se deriva de customerData.country (CH/FR no son un idioma)');
  ok(!/customer_country[\s\S]{0,80}locale/i.test(adminSrc) && !/locale[\s\S]{0,80}customer_country/i.test(adminSrc),
    'routes/admin.js: el locale del cambio de estado nunca se deriva de customer_country');
}

// =======================================================================
// 10) Reply-To (sección 10): cliente->soporte, admin->cliente, contacto->visitante
// =======================================================================
function checkReplyToWiring() {
  const paymentsSrc = readFile('routes/payments.js');
  const adminSrc = readFile('routes/admin.js');
  const contactSrc = readFile('routes/contact.js');

  ok(/to:\s*customerData\.email,\s*\n\s*replyTo:\s*SUPPORT_INFO\.email/.test(paymentsSrc), 'routes/payments.js: email al CLIENTE tiene Reply-To = soporte LITUM3D (contact@litum3d.com)');
  ok(/to:\s*process\.env\.ADMIN_EMAIL[^\n]*\n\s*replyTo:\s*customerData\.email/.test(paymentsSrc), 'routes/payments.js: email a ADMIN tiene Reply-To = email del cliente (responder llega directo al cliente)');
  ok(/replyTo:\s*SUPPORT_INFO\.email/.test(adminSrc), 'routes/admin.js: email de cambio de estado (al cliente) tiene Reply-To = soporte LITUM3D');
  ok(/replyTo:\s*email\b/.test(contactSrc), 'routes/contact.js: Reply-To = email introducido por el visitante (LITUM3D responde directo al cliente)');
}

// =======================================================================
// 11) Sin plantillas HTML duplicadas / transporters duplicados
// =======================================================================
function checkNoDuplicatedTemplatesOrTransporters() {
  const paymentsSrc = readFile('routes/payments.js');
  const adminSrc = readFile('routes/admin.js');
  const contactSrc = readFile('routes/contact.js');

  ok(!/nodemailer\.createTransport/.test(paymentsSrc), 'routes/payments.js: ya no crea su propio transporter (usa services/mailer.js)');
  ok(!/nodemailer\.createTransport/.test(adminSrc), 'routes/admin.js: ya no crea su propio transporter (usa services/mailer.js)');
  ok(!/nodemailer\.createTransport/.test(contactSrc), 'routes/contact.js: ya no crea su propio transporter (usa services/mailer.js)');

  ok(!/<div class="header">[\s\S]*linear-gradient\(135deg, #64c8ff/.test(adminSrc), 'routes/admin.js: el degradado azul/morado genérico (sin relación con LITUM3D) ya no existe');
  ok(/buildStatusChangeEmail/.test(adminSrc), 'routes/admin.js: usa la plantilla central (buildStatusChangeEmail), no HTML propio');
  ok(/buildOrderConfirmationEmail/.test(paymentsSrc) && /buildAdminNewOrderEmail/.test(paymentsSrc), 'routes/payments.js: usa la plantilla central para ambos emails de pedido');
}

// =======================================================================
// 12) Búsqueda global: cero reintroducción de IVA en TODA la arquitectura de emails
// =======================================================================
function checkNoVatReintroducedAnywhereInEmailStack() {
  const FILES = [
    'services/email-template.js',
    'services/order-emails.js',
    'services/mailer.js',
    'routes/payments.js',
    'routes/admin.js',
    'routes/contact.js'
  ];
  for (const relPath of FILES) {
    const src = readFile(relPath);
    ok(!NO_VAT_PATTERN.test(src), `${relPath}: sin ningún rastro de IVA/VAT/MwSt/TVA 21% ni total/1.21`);
    // Se prohíbe LEER/CALCULAR .netCents/.taxCents (acceso real a esas
    // propiedades), no la mera mención en un comentario que documenta que
    // nunca se usan (p.ej. "nunca netCents/taxCents: sin IVA").
    ok(!/\.netCents\b|\.taxCents\b/.test(src), `${relPath}: no accede a .netCents/.taxCents (sin desglose fiscal calculado)`);
  }
}

// =======================================================================
// 13) mailer.js: FROM usa la cuenta autenticada real, sanitiza cabeceras
// =======================================================================
function checkMailerFromAndHeaderSanitization() {
  const originalUser = process.env.SMTP_USER;
  try {
    process.env.SMTP_USER = 'ops@litum3d.com';
    eq(mailer.getFromAddress(), 'LITUM3D <ops@litum3d.com>', 'getFromAddress() usa SMTP_USER real con nombre de marca');
    eq(mailer.getFromAddress('LITUM3D Contact'), 'LITUM3D Contact <ops@litum3d.com>', 'getFromAddress() acepta un display name distinto (contacto)');
  } finally {
    if (originalUser === undefined) delete process.env.SMTP_USER; else process.env.SMTP_USER = originalUser;
  }
  eq(mailer.sanitizeHeaderValue('Ana\r\nBcc: evil@x.com'), 'Ana Bcc: evil@x.com', 'sanitizeHeaderValue elimina CR/LF (anti header-injection) sin depender de escape HTML');
}

// =======================================================================
async function main() {
  checkBrandingUsesRealAssets();
  checkSupportInfoMatchesRealPublicData();
  checkFooterLegalLinksAreAbsoluteAndLocalized();
  checkSupportBlockToggle();
  checkHtmlEscaping();
  checkOrderConfirmationEmail();
  checkAdminNewOrderEmail();
  checkStatusChangeEmail();
  checkLocaleNeverInferredFromCountry();
  checkReplyToWiring();
  checkNoDuplicatedTemplatesOrTransporters();
  checkNoVatReintroducedAnywhereInEmailStack();
  checkMailerFromAndHeaderSanitization();

  console.log(`OK: ${checks} comprobaciones sobre la profesionalización del sistema de emails (branding, plantilla única, Reply-To, escape HTML, ausencia de IVA).`);
}

main().catch(err => {
  console.error('FALLO en check-email-branding.js:', err.message);
  process.exit(1);
});
