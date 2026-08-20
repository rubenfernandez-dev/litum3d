/*
  LITUM3D - Test de regresión: refinar branding y limitar los emails
  automáticos AL CLIENTE a eventos realmente notificables (informe "refinar
  branding y notificaciones de emails", 2026-08-20).

  Cubre:
    - El cliente SOLO recibe email automático por: Pedido recibido (pago
      confirmado), Enviado y Entregado (routes/admin.js#NOTIFIABLE_STATUSES).
      Ningún estado operativo intermedio (Pendiente/Confirmado/Preparando/
      Cancelado) genera email al cliente.
    - Protección de duplicados: estadoAnteriorId !== nuevoEstadoId ya existente
      (routes/admin.js) sigue evitando reenviar el mismo email si se vuelve a
      guardar el mismo estado (Enviado->Enviado, Entregado->Entregado).
    - El aviso interno "Nuevo pedido pagado" a ADMIN_EMAIL sigue intacto (NO
      es un email automático al cliente, ver informe sección 8).
    - El formulario de contacto sigue intacto (mensaje -> soporte, Reply-To ->
      visitante), sin autorespuesta nueva.
    - Reply-To de emails al cliente sigue siendo contact@litum3d.com.
    - Locale ES/DE/FR/EN intacto en los eventos notificables.
    - Logo oficial (logo.png, nunca lineal.logo.png) y footer sin IVA.

  NO toca red real ni BD real: BD y SMTP se sustituyen por fakes en memoria
  (mismo patrón que scripts/check-email-locale-persistence.js).

  Uso: node scripts/check-email-notifications-allowlist.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); checks++; }

const ROOT = path.join(__dirname, '..');
function readFile(relPath) { return fs.readFileSync(path.join(ROOT, relPath), 'utf8'); }

const orderEmails = require('../services/order-emails');
const emailTemplate = require('../services/email-template');

const NO_VAT_PATTERN = /IVA\s*\(?21|VAT\s*\(?21|MwSt\.?\s*\(?21|TVA\s*\(?21|21\s*%|\/\s*1\.21|Base\s*\(sin IVA\)/i;

// =======================================================================
// Fakes compartidos: BD (pedidos/estado_pedido/historial/drafts) y SMTP.
// =======================================================================
function installFakeDbModule(fakePool) {
  const dbPath = require.resolve('../config/db');
  const original = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: fakePool } };
  return () => { if (original) require.cache[dbPath] = original; else delete require.cache[dbPath]; };
}

function installFakeNodemailerModule(sentMails) {
  const nmPath = require.resolve('nodemailer');
  const original = require.cache[nmPath];
  require.cache[nmPath] = {
    id: nmPath, filename: nmPath, loaded: true,
    exports: { createTransport() { return { async sendMail(opts) { sentMails.push(opts); return { messageId: 'fake' }; } }; } }
  };
  return () => { if (original) require.cache[nmPath] = original; else delete require.cache[nmPath]; };
}

const ESTADO_IDS = { 'Pendiente': 1, 'Confirmado': 2, 'Preparando': 3, 'Enviado': 4, 'Entregado': 5, 'Cancelado': 6 };

function makeFakePoolWithDrafts({ orders, drafts }) {
  return {
    async query(sql, params = []) {
      if (sql.includes('SELECT id FROM estado_pedido WHERE nombre')) {
        const id = ESTADO_IDS[params[0]];
        return [id ? [{ id }] : []];
      }
      if (sql.includes('SELECT p.id, p.usuario_id, p.estado_id, p.stripe_payment_intent_id')) {
        const id = Number(params[0]);
        const row = orders.find(o => o.id === id);
        if (!row) return [[]];
        return [[{ id: row.id, usuario_id: null, estado_id: row.estado_id, stripe_payment_intent_id: row.stripe_payment_intent_id || null, email: row.email, nombre: row.nombre, total: row.total }]];
      }
      if (sql.includes('INSERT INTO historial_estado_pedido')) {
        return [{ insertId: 1 }];
      }
      if (sql.includes('UPDATE pedidos SET estado_id')) {
        const [nuevoEstadoId, id] = params;
        const order = orders.find(o => o.id === Number(id));
        if (order) order.estado_id = nuevoEstadoId;
        return [{ affectedRows: order ? 1 : 0 }];
      }
      if (sql.includes('SELECT * FROM checkout_drafts WHERE stripe_payment_intent_id')) {
        const draft = drafts.find(d => d.stripe_payment_intent_id === params[0]);
        return [draft ? [draft] : []];
      }
      // Disparado por order-photo-retention.js cuando estado==='Entregado' -- sin
      // fotos que limpiar en este fake, siempre devuelve 0 filas.
      if (sql.includes('FROM detalle_pedido_imagenes')) {
        return [[]];
      }
      throw new Error(`Fake pool (allowlist test): consulta no reconocida: ${sql}`);
    }
  };
}

function loadFreshAdminRouter(fakePool) {
  const restoreDb = installFakeDbModule(fakePool);
  const adminPath = require.resolve('../routes/admin');
  const retentionPath = require.resolve('../services/order-photo-retention');
  delete require.cache[adminPath];
  delete require.cache[retentionPath];
  const router = require('../routes/admin');
  restoreDb();
  delete require.cache[adminPath];
  delete require.cache[retentionPath];
  return router;
}

async function startTestServer(router, mountPath) {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { adminId: 1, csrfToken: 'test-csrf-token' };
    next();
  });
  app.use(mountPath, router);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return server;
}

function draftFor(paymentIntentId, locale, name) {
  return {
    id: Math.floor(Math.random() * 1e6), stripe_payment_intent_id: paymentIntentId, status: 'converted',
    snapshot_json: JSON.stringify({ currency: 'eur', items: [], totals: { totalCents: 4995, shippingCents: 0 }, customerData: { name, locale, country: 'CH' } }),
    idempotency_key: `idem-${paymentIntentId}`, selections_fingerprint: 'f'.repeat(64), access_token_hash: 'a'.repeat(64),
    created_at: new Date(), updated_at: new Date(), expires_at: null
  };
}

// =======================================================================
// 1) Estados operativos intermedios: NUNCA generan email al cliente
// =======================================================================
async function checkIntermediateStatusesNeverEmailCustomer() {
  const orders = [
    { id: 1001, estado_id: ESTADO_IDS['Pendiente'], stripe_payment_intent_id: 'pi_1001', email: 'cliente1@example.com', nombre: 'Cliente Uno', total: '49.95' }
  ];
  const drafts = [draftFor('pi_1001', 'es', 'Cliente Uno')];
  const fakePool = makeFakePoolWithDrafts({ orders, drafts });
  const router = loadFreshAdminRouter(fakePool);
  const server = await startTestServer(router, '/admin');
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const sentMails = [];
  const restoreNodemailer = installFakeNodemailerModule(sentMails);

  try {
    // Pendiente -> Confirmado -> Preparando -> Cancelado: ninguno debe emitir email.
    for (const estado of ['Confirmado', 'Preparando', 'Cancelado']) {
      const res = await fetch(`${base}/admin/pedidos/1001/estado`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf-token' },
        body: JSON.stringify({ estado })
      });
      eq(res.status, 200, `PUT estado=${estado} -> 200`);
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    eq(sentMails.length, 0, 'Pendiente->Confirmado->Preparando->Cancelado: 0 emails al cliente (ningún estado operativo intermedio notifica)');
  } finally {
    restoreNodemailer();
    server.close();
  }
}

// =======================================================================
// 2) Enviado: exactamente 1 email; reenviar el mismo estado NO duplica
// =======================================================================
async function checkEnviadoSendsOnceAndNeverDuplicates() {
  const orders = [
    { id: 1002, estado_id: ESTADO_IDS['Preparando'], stripe_payment_intent_id: 'pi_1002', email: 'cliente2@example.com', nombre: 'Cliente Dos', total: '49.95' }
  ];
  const drafts = [draftFor('pi_1002', 'es', 'Cliente Dos')];
  const fakePool = makeFakePoolWithDrafts({ orders, drafts });
  const router = loadFreshAdminRouter(fakePool);
  const server = await startTestServer(router, '/admin');
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const sentMails = [];
  const restoreNodemailer = installFakeNodemailerModule(sentMails);

  try {
    async function putEstado(estado) {
      const res = await fetch(`${base}/admin/pedidos/1002/estado`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf-token' },
        body: JSON.stringify({ estado })
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      return res;
    }

    const res1 = await putEstado('Enviado');
    eq(res1.status, 200, 'Preparando -> Enviado: 200');
    eq(sentMails.length, 1, 'Enviado: exactamente 1 email al cliente');
    eq(sentMails[0].to, 'cliente2@example.com', 'Enviado: el email llega al cliente correcto');
    ok(sentMails[0].subject.includes('Tu pedido ha sido enviado'), 'Enviado: subject del evento "enviado"');

    const res2 = await putEstado('Enviado');
    eq(res2.status, 200, 'Enviado -> Enviado (re-guardar el mismo estado): 200');
    eq(sentMails.length, 1, 'Enviado->Enviado: 0 emails NUEVOS (sigue en 1, protección estadoAnteriorId !== nuevoEstadoId)');

    const res3 = await putEstado('Enviado');
    eq(res3.status, 200, 'Enviado -> Enviado otra vez: 200');
    eq(sentMails.length, 1, 'Enviado->Enviado (repetido de nuevo): sigue sin duplicar');
  } finally {
    restoreNodemailer();
    server.close();
  }
}

// =======================================================================
// 3) Entregado: exactamente 1 email; reenviar el mismo estado NO duplica
// =======================================================================
async function checkEntregadoSendsOnceAndNeverDuplicates() {
  const orders = [
    { id: 1003, estado_id: ESTADO_IDS['Enviado'], stripe_payment_intent_id: 'pi_1003', email: 'cliente3@example.com', nombre: 'Cliente Tres', total: '49.95' }
  ];
  const drafts = [draftFor('pi_1003', 'es', 'Cliente Tres')];
  const fakePool = makeFakePoolWithDrafts({ orders, drafts });
  const router = loadFreshAdminRouter(fakePool);
  const server = await startTestServer(router, '/admin');
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const sentMails = [];
  const restoreNodemailer = installFakeNodemailerModule(sentMails);

  try {
    async function putEstado(estado) {
      const res = await fetch(`${base}/admin/pedidos/1003/estado`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf-token' },
        body: JSON.stringify({ estado })
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      return res;
    }

    const res1 = await putEstado('Entregado');
    eq(res1.status, 200, 'Enviado -> Entregado: 200');
    eq(sentMails.length, 1, 'Entregado: exactamente 1 email al cliente');
    ok(sentMails[0].subject.includes('Tu pedido ha sido entregado'), 'Entregado: subject del evento "entregado"');

    const res2 = await putEstado('Entregado');
    eq(res2.status, 200, 'Entregado -> Entregado (re-guardar el mismo estado): 200');
    eq(sentMails.length, 1, 'Entregado->Entregado: 0 emails NUEVOS (sigue en 1)');
  } finally {
    restoreNodemailer();
    server.close();
  }
}

// =======================================================================
// 4) Locale ES/DE/FR/EN intacto en los eventos notificables (Enviado/Entregado)
// =======================================================================
async function checkNotifiableEventsRespectLocale() {
  const CASES = [
    { locale: 'es', subjectPart: 'Tu pedido ha sido enviado' },
    { locale: 'de', subjectPart: 'Deine Bestellung wurde versendet' },
    { locale: 'fr', subjectPart: 'Votre commande a été expédiée' },
    { locale: 'en', subjectPart: 'Your order has been shipped' }
  ];
  const orders = CASES.map((c, i) => ({
    id: 1100 + i, estado_id: ESTADO_IDS['Preparando'], stripe_payment_intent_id: `pi_locale_${c.locale}`,
    email: `cliente-${c.locale}@example.com`, nombre: `Cliente ${c.locale.toUpperCase()}`, total: '49.95'
  }));
  const drafts = CASES.map(c => draftFor(`pi_locale_${c.locale}`, c.locale, `Cliente ${c.locale.toUpperCase()}`));
  const fakePool = makeFakePoolWithDrafts({ orders, drafts });
  const router = loadFreshAdminRouter(fakePool);
  const server = await startTestServer(router, '/admin');
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const sentMails = [];
  const restoreNodemailer = installFakeNodemailerModule(sentMails);

  try {
    for (let i = 0; i < CASES.length; i++) {
      const orderId = 1100 + i;
      const res = await fetch(`${base}/admin/pedidos/${orderId}/estado`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf-token' },
        body: JSON.stringify({ estado: 'Enviado' })
      });
      eq(res.status, 200, `locale=${CASES[i].locale}: PUT estado=Enviado -> 200`);
    }
    await new Promise(resolve => setTimeout(resolve, 0));

    for (const c of CASES) {
      const mail = sentMails.find(m => m.to === `cliente-${c.locale}@example.com`);
      ok(mail, `locale=${c.locale}: el email de Enviado se envió`);
      ok(mail.subject.includes(c.subjectPart), `locale=${c.locale}: subject en el idioma persistido del comprador ("${c.subjectPart}")`);
      ok(mail.replyTo === emailTemplate.SUPPORT_INFO.email, `locale=${c.locale}: Reply-To sigue siendo ${emailTemplate.SUPPORT_INFO.email}`);
    }
  } finally {
    restoreNodemailer();
    server.close();
  }
}

// =======================================================================
// 5) Pedido recibido (confirmación de pago): sigue generando email cliente
//    con el subject nuevo ("Pedido recibido"), no es responsabilidad del
//    cambio de estado Admin -- pertenece al flujo de pago.
// =======================================================================
function checkOrderReceivedStillBuildsCorrectly() {
  const customerData = { name: 'Cliente Pago', email: 'pago@example.com', phone: '+41791234567', address: 'Bahnhofstrasse 1', city: 'Bern', zip: '3000', country: 'CH' };
  const items = [{ productName: 'Litofanía', modelName: null, variantSelections: [], extras: {}, quantity: 1, unitPriceCents: 4995 }];
  const totals = { shippingCents: 0, totalCents: 4995 };
  for (const [locale, expected] of Object.entries({ es: 'Pedido recibido', de: 'Bestellung erhalten', fr: 'Commande reçue', en: 'Order received' })) {
    const result = orderEmails.buildOrderConfirmationEmail({ locale, orderId: 2001, orderDate: new Date('2026-08-20T10:00:00Z'), customerData, items, totals, currency: 'eur' });
    ok(result.subject.includes(expected), `Pedido recibido (${locale}): subject incluye "${expected}"`);
    ok(result.subject.includes('#2001'), `Pedido recibido (${locale}): subject referencia el pedido`);
  }

  const paymentsSrc = readFile('routes/payments.js');
  ok(/to:\s*customerData\.email,\s*\n\s*replyTo:\s*SUPPORT_INFO\.email/.test(paymentsSrc), 'routes/payments.js: el email de "Pedido recibido" sigue con Reply-To = soporte LITUM3D');
}

// =======================================================================
// 6) Aviso interno "Nuevo pedido pagado" a ADMIN_EMAIL: sigue intacto
//    (NO es un email automático al cliente, ver informe sección 8)
// =======================================================================
function checkAdminNewOrderNotificationStillIntact() {
  const paymentsSrc = readFile('routes/payments.js');
  ok(/buildAdminNewOrderEmail/.test(paymentsSrc), 'routes/payments.js: sigue construyendo el email interno "Nuevo pedido pagado" a Admin');
  ok(/to:\s*process\.env\.ADMIN_EMAIL[^\n]*\n\s*replyTo:\s*customerData\.email/.test(paymentsSrc), 'routes/payments.js: el email a Admin sigue con to=ADMIN_EMAIL y Reply-To=email del cliente');

  const customerData = { name: 'Ruben Fernandez', email: 'ruben@example.com', phone: '+41791234567', address: 'Bahnhofstrasse 1', city: 'Bern', zip: '3000', country: 'CH' };
  const items = [{ productName: 'Litofanía Circular', modelName: null, variantSelections: [], extras: {}, quantity: 1, unitPriceCents: 4995 }];
  const totals = { shippingCents: 0, totalCents: 4995 };
  const adminEmail = orderEmails.buildAdminNewOrderEmail({ orderId: 2002, orderDate: new Date(), customerData, items, totals, currency: 'eur', hasPhotos: false });
  ok(adminEmail.subject.includes('Nuevo Pedido Pagado') && adminEmail.subject.includes('#2002'), 'admin: subject "Nuevo Pedido Pagado" sigue intacto');
  ok(adminEmail.html.includes(customerData.name) && adminEmail.html.includes(customerData.email) && adminEmail.html.includes(customerData.phone), 'admin: cliente/email/teléfono siguen visibles');
  ok(adminEmail.html.includes(customerData.address) && adminEmail.html.includes('CH'), 'admin: dirección y país siguen visibles');
  ok(adminEmail.html.includes('Litofanía Circular'), 'admin: productos del pedido siguen visibles');
  ok(adminEmail.html.includes('49,95'), 'admin: total sigue visible');
}

// =======================================================================
// 7) Formulario de contacto: sigue intacto (mensaje -> soporte, Reply-To ->
//    visitante), sin autorespuesta nueva al visitante.
// =======================================================================
async function checkContactFormStillIntact() {
  const contactedRows = [];
  const fakePool = {
    async query(sql, params = []) {
      if (sql.includes('INSERT INTO contacto')) {
        contactedRows.push(params);
        return [{ insertId: contactedRows.length }];
      }
      throw new Error(`Fake pool (contact test): consulta no reconocida: ${sql}`);
    }
  };
  const restoreDb = installFakeDbModule(fakePool);
  const contactPath = require.resolve('../routes/contact');
  delete require.cache[contactPath];
  const router = require('../routes/contact');
  restoreDb();
  delete require.cache[contactPath];

  const server = await startTestServer(router, '/');
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const sentMails = [];
  const restoreNodemailer = installFakeNodemailerModule(sentMails);
  const originalSmtpHost = process.env.SMTP_HOST;
  const originalSmtpUser = process.env.SMTP_USER;
  const originalContactTo = process.env.CONTACT_TO;
  process.env.SMTP_HOST = 'smtp.test.local';
  process.env.SMTP_USER = 'ops@litum3d.com';
  process.env.CONTACT_TO = 'contact@litum3d.com';

  try {
    const res = await fetch(`${base}/api/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Visitante', email: 'visitante@example.com', asunto: 'Duda', message: 'Hola, tengo una duda.' })
    });
    eq(res.status, 201, 'POST /api/contact -> 201 (sigue funcionando)');
    eq(contactedRows.length, 1, 'contacto: se guarda una fila en BD');

    await new Promise(resolve => setTimeout(resolve, 0));
    eq(sentMails.length, 1, 'contacto: se envía exactamente 1 email a soporte (nunca una autorespuesta adicional al visitante)');
    eq(sentMails[0].to, 'contact@litum3d.com', 'contacto: el mensaje llega a soporte (CONTACT_TO)');
    eq(sentMails[0].replyTo, 'visitante@example.com', 'contacto: Reply-To = email del visitante (LITUM3D responde directo al cliente)');
  } finally {
    restoreNodemailer();
    if (originalSmtpHost === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = originalSmtpHost;
    if (originalSmtpUser === undefined) delete process.env.SMTP_USER; else process.env.SMTP_USER = originalSmtpUser;
    if (originalContactTo === undefined) delete process.env.CONTACT_TO; else process.env.CONTACT_TO = originalContactTo;
    server.close();
  }
}

// =======================================================================
// 8) Logo oficial de email: logo.png (nunca lineal.logo.png), y footer sin IVA
// =======================================================================
function checkOfficialLogoAndFooterInvariants() {
  const logoUrl = emailTemplate.getLogoUrl();
  eq(logoUrl, 'https://litum3d.com/img/logos/logo.png', 'getLogoUrl() apunta exactamente al logo oficial pedido');
  ok(!logoUrl.includes('lineal.logo.png'), 'getLogoUrl() nunca usa lineal.logo.png');

  const { html, text } = emailTemplate.renderLitumEmail({ locale: 'es', title: 'T', contentHtml: '<p>x</p>', contentText: 'x' });
  ok(html.includes('src="https://litum3d.com/img/logos/logo.png"'), 'el HTML del email referencia el logo oficial con URL absoluta');
  ok(!html.includes('background:#ffffff; padding:6px 10px; border-radius:10px;'), 'el header ya NO envuelve el logo en una tarjeta/cuadrado blanco');
  ok(html.includes('width:180px'), 'el logo se muestra con un ancho fijo dentro del rango pedido (170-190px)');
  ok(html.includes('height:auto'), 'el logo mantiene proporciones (height:auto, sin deformar)');
  ok(!NO_VAT_PATTERN.test(html) && !NO_VAT_PATTERN.test(text), 'el layout base sigue sin ningún rastro de IVA/VAT/MwSt/TVA 21%');

  const taglines = { es: 'Litofanías 3D personalizadas', de: 'Personalisierte 3D-Lithophanien', fr: 'Lithophanies 3D personnalisées', en: 'Personalised 3D lithophanes' };
  for (const [locale, tagline] of Object.entries(taglines)) {
    const rendered = emailTemplate.renderLitumEmail({ locale, title: 'T', contentHtml: '<p>x</p>', contentText: 'x' });
    ok(rendered.html.includes(tagline), `footer (${locale}): tagline actualizado ("${tagline}")`);
    ok(!rendered.html.includes('Premium 3D'), `footer (${locale}): ya no muestra el tagline anterior ("Premium 3D...")`);
  }
}

// =======================================================================
async function main() {
  await checkIntermediateStatusesNeverEmailCustomer();
  await checkEnviadoSendsOnceAndNeverDuplicates();
  await checkEntregadoSendsOnceAndNeverDuplicates();
  await checkNotifiableEventsRespectLocale();
  checkOrderReceivedStillBuildsCorrectly();
  checkAdminNewOrderNotificationStillIntact();
  await checkContactFormStillIntact();
  checkOfficialLogoAndFooterInvariants();

  console.log(`OK: ${checks} comprobaciones sobre la allowlist de eventos notificables, protección de duplicados, Admin/Contacto intactos, locale y branding.`);
}

main().catch(err => {
  console.error('FALLO en check-email-notifications-allowlist.js:', err.message);
  process.exit(1);
});
