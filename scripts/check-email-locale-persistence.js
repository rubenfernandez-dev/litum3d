/*
  LITUM3D - Test de regresión: persistencia del locale del comprador para
  emails transaccionales (informe "persistir locale del comprador" +
  "añadir locale EN").

  Cubre el flujo completo:
    document.documentElement.lang (public/js/checkout.js)
      -> customerData.locale (normalizado, allowlist es/de/fr/en)
      -> services/checkout-drafts.js#validateCustomerData (persistido en
         checkout_drafts.snapshot_json, SIN migración de schema)
      -> email de confirmación inmediato (routes/payments.js)
      -> email de cambio de estado posterior, días después, recuperado por
         routes/admin.js vía pedidos.stripe_payment_intent_id <->
         checkout_drafts.stripe_payment_intent_id (el draft nunca se borra).

  El país de envío NUNCA determina el idioma (CH es DE/FR/IT; un FR puede
  comprar estando en CH): se prueba explícitamente con combinaciones
  locale/country cruzadas, incluido EN (que no tiene ningún país "propio").

  Uso: node scripts/check-email-locale-persistence.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); checks++; }

const ROOT = path.join(__dirname, '..');
function readScript(relPath) { return fs.readFileSync(path.join(ROOT, relPath), 'utf8'); }

const { normalizeLocale, ALLOWED_LOCALES, DEFAULT_LOCALE } = require('../config/locales');
const { validateCustomerData, getDraftByPaymentIntentId, DraftValidationError } = require('../services/checkout-drafts');
const { buildOrderConfirmationEmail } = require('../services/order-emails');

// =======================================================================
// 1) Normalizador central (config/locales.js)
// =======================================================================
function checkCentralNormalizeLocale() {
  eq(DEFAULT_LOCALE, 'es', 'DEFAULT_LOCALE es "es"');
  assert.deepStrictEqual([...ALLOWED_LOCALES], ['es', 'de', 'fr', 'en'], 'ALLOWED_LOCALES es exactamente es/de/fr/en');
  for (const loc of ['es', 'de', 'fr', 'en']) {
    eq(normalizeLocale(loc), loc, `normalizeLocale("${loc}") pasa tal cual`);
  }
  eq(normalizeLocale('it'), 'es', 'normalizeLocale("it") -> fallback "es" (italiano no soportado)');
  eq(normalizeLocale('DE'), 'es', 'normalizeLocale("DE") -> fallback "es" (case-sensitive, no normaliza mayúsculas)');
  eq(normalizeLocale(undefined), 'es', 'normalizeLocale(undefined) -> fallback "es"');
  eq(normalizeLocale(null), 'es', 'normalizeLocale(null) -> fallback "es"');
  eq(normalizeLocale(''), 'es', 'normalizeLocale("") -> fallback "es"');
  eq(normalizeLocale(123), 'es', 'normalizeLocale(valor no-string) -> fallback "es", nunca lanza');
  eq(normalizeLocale('../../etc/passwd'), 'es', 'normalizeLocale con intento de path traversal -> fallback "es" (nunca se usa para filesystem)');
}

// =======================================================================
// 2) Frontend: public/js/checkout.js normaliza document.documentElement.lang
//    y lo añade a customerData.locale (código REAL en un sandbox vm)
// =======================================================================
function makeFormStub() {
  const fields = ['customer_name', 'customer_email', 'customer_phone', 'customer_address', 'customer_city', 'customer_zip'];
  const form = { checkValidity: () => true, reportValidity: () => {}, addEventListener() {} };
  for (const f of fields) form[f] = { value: 'x' };
  form.customer_country = { value: 'CH' };
  return form;
}

function loadMinimalCheckoutSandbox(lang) {
  const registry = new Map();
  const elementStub = () => ({ textContent: '', innerHTML: '', value: '', style: {}, addEventListener() {} });
  const doc = {
    getElementById(id) { if (!registry.has(id)) registry.set(id, elementStub()); return registry.get(id); },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => elementStub(),
    documentElement: { lang }
  };
  const sandbox = {
    console,
    document: doc,
    window: { location: { origin: 'https://litum3d.example', href: '' }, addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    crypto: require('crypto').webcrypto,
    fetch: async () => ({ ok: false, json: async () => ({ ok: false }) }),
    Stripe: () => ({})
  };
  vm.createContext(sandbox);
  vm.runInContext(readScript('public/js/cart.js'), sandbox, { filename: 'cart.js' });
  vm.runInContext(readScript('public/js/checkout.js'), sandbox, { filename: 'checkout.js' });
  return sandbox;
}

function checkFrontendAddsNormalizedLocaleToCustomerData() {
  const CASES = [
    { lang: 'de', expected: 'de' },
    { lang: 'fr', expected: 'fr' },
    { lang: 'es', expected: 'es' },
    { lang: 'en', expected: 'en' },
    { lang: 'it', expected: 'es' },
    { lang: '', expected: 'es' },
    { lang: undefined, expected: 'es' }
  ];
  for (const { lang, expected } of CASES) {
    const sandbox = loadMinimalCheckoutSandbox(lang);
    const form = makeFormStub();
    const data = vm.runInContext('getCustomerData', sandbox, { filename: 'harness.js' })(form);
    eq(data.locale, expected, `document.documentElement.lang="${lang}" -> customerData.locale="${expected}"`);
    // El país seleccionado nunca se usa para decidir el locale (sanity del propio stub: CH).
    eq(data.country, 'CH', 'sanity: country del formulario no cambia según el locale');
  }
}

// =======================================================================
// 3) services/checkout-drafts.js#validateCustomerData persiste locale
//    (campo OPCIONAL: ausente/legacy -> 'es', nunca "obligatorio")
// =======================================================================
function checkValidateCustomerDataPersistsLocale() {
  const BASE = { name: 'Ana', email: 'ana@example.com', phone: '+41791234567', address: 'Calle 1', city: 'Bern', zip: '3000', country: 'CH' };

  for (const loc of ['es', 'de', 'fr', 'en']) {
    const normalized = validateCustomerData({ ...BASE, locale: loc });
    eq(normalized.locale, loc, `validateCustomerData persiste locale="${loc}" tal cual`);
  }

  eq(validateCustomerData({ ...BASE, locale: 'it' }).locale, 'es', 'locale no soportado ("it") se normaliza a "es", sin rechazar todo el customerData');
  eq(validateCustomerData({ ...BASE }).locale, 'es', 'customerData SIN locale (cliente/draft anterior a este cambio) -> "es", NUNCA "obligatorio"');

  // Los otros 7 campos siguen siendo estrictamente obligatorios (regresión:
  // añadir locale como opcional no debe relajar el resto).
  assert.throws(() => validateCustomerData({ ...BASE, name: '' }), DraftValidationError, 'name sigue siendo obligatorio');
  assert.throws(() => validateCustomerData({ ...BASE, country: 'XX' }), DraftValidationError, 'country sigue validándose contra la allowlist de países');
  assert.throws(() => validateCustomerData({ ...BASE, extra: 'x' }), DraftValidationError, 'un campo desconocido (ajeno a locale) se sigue rechazando');
  checks += 3;
}

// =======================================================================
// 4) getDraftByPaymentIntentId: recuperación del draft por PI, sin migración
// =======================================================================
async function checkGetDraftByPaymentIntentId() {
  const FAKE_ROW = {
    id: 42, idempotency_key: 'idem-1', selections_fingerprint: 'f'.repeat(64), access_token_hash: 'a'.repeat(64),
    stripe_payment_intent_id: 'pi_locale_test', status: 'converted',
    snapshot_json: JSON.stringify({ currency: 'eur', items: [], totals: { totalCents: 100, shippingCents: 0 }, customerData: { name: 'Ana', locale: 'de', country: 'CH' } }),
    created_at: new Date(), updated_at: new Date(), expires_at: null
  };
  let queriedIds = [];
  const fakeDataAccess = {
    async findByPaymentIntentId(id) { queriedIds.push(id); return id === 'pi_locale_test' ? FAKE_ROW : null; }
  };

  const found = await getDraftByPaymentIntentId('pi_locale_test', { dataAccess: fakeDataAccess });
  ok(found && found.snapshot.customerData.locale === 'de', 'getDraftByPaymentIntentId recupera snapshot.customerData.locale de un draft ya convertido en pedido');

  const notFound = await getDraftByPaymentIntentId('pi_desconocido', { dataAccess: fakeDataAccess });
  eq(notFound, null, 'paymentIntentId desconocido -> null (nunca lanza)');

  const noId = await getDraftByPaymentIntentId(undefined, { dataAccess: fakeDataAccess });
  eq(noId, null, 'paymentIntentId ausente (pedido legacy sin stripe_payment_intent_id) -> null');
  eq(queriedIds.includes(undefined), false, 'con paymentIntentId ausente, ni siquiera se llega a consultar la BD (short-circuit)');
}

// =======================================================================
// 5) Confirmación: el locale mostrado es el persistido, el país NUNCA
//    determina el idioma (los 3 cruces explícitos que pide el informe)
// =======================================================================
function checkConfirmationEmailLocaleNeverFromCountry() {
  const items = [{ productName: 'Litofanía', modelName: null, variantSelections: [], extras: {}, quantity: 1, unitPriceCents: 4995 }];
  const totals = { shippingCents: 0, totalCents: 4995 };
  const orderDate = new Date('2026-03-01T10:00:00Z');

  const CASES = [
    { locale: 'de', country: 'CH', expectSubjectPart: 'Bestellbestätigung' },
    { locale: 'fr', country: 'CH', expectSubjectPart: 'Confirmation de commande' },
    { locale: 'es', country: 'DE', expectSubjectPart: 'Confirmación de pedido' },
    // EN (informe "añadir locale EN"): sin país "propio" -- se prueba
    // explícitamente cruzado con CH/DE/FR, exactamente como pide el informe.
    { locale: 'en', country: 'CH', expectSubjectPart: 'Order confirmation' },
    { locale: 'en', country: 'DE', expectSubjectPart: 'Order confirmation' },
    { locale: 'en', country: 'FR', expectSubjectPart: 'Order confirmation' }
  ];
  for (const { locale, country, expectSubjectPart } of CASES) {
    const customerData = { name: 'Cliente', email: 'c@example.com', phone: '+1', address: 'Addr 1', city: 'City', zip: '1', country, locale };
    const result = buildOrderConfirmationEmail({ locale: customerData.locale, orderId: 700, orderDate, customerData, items, totals, currency: 'eur' });
    ok(result.subject.includes(expectSubjectPart), `locale="${locale}" + country="${country}": el email sale en el idioma del LOCALE ("${expectSubjectPart}"), el país (${country}) no lo cambia`);
  }
}

// =======================================================================
// 6) Cambio de estado posterior desde Admin: recupera el locale del draft
//    original DÍAS después, vía stripe_payment_intent_id -- integración
//    HTTP real sobre una copia fresca de routes/admin.js con BD/nodemailer
//    falsos dedicados a este test (no se reutiliza el fake pool gigante de
//    check-admin-order-photos-retention.js: este es más simple y focalizado).
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

function makeFakePoolWithDrafts({ orders, drafts }) {
  const ESTADO_IDS = { 'Pendiente': 1, 'Confirmado': 2, 'Preparando': 3, 'Enviado': 4, 'Entregado': 5, 'Cancelado': 6 };
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
      throw new Error(`Fake pool (locale persistence test): consulta no reconocida: ${sql}`);
    }
  };
}

async function startAdminTestServer(router) {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { adminId: 1, csrfToken: 'test-csrf-token' };
    next();
  });
  app.use('/admin', router);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return server;
}

async function checkAdminStatusChangeRecoversLocaleFromOriginalDraft() {
  const orders = [
    // Pedido reciente: SÍ tiene stripe_payment_intent_id -> debe recuperar locale='de' del draft.
    { id: 601, estado_id: 2, stripe_payment_intent_id: 'pi_de_601', email: 'cliente-de@example.com', nombre: 'Kunde DE', total: '49.95' },
    // Pedido legacy (anterior a este cambio, o draft ya no localizable): sin PI -> debe caer a 'es'.
    { id: 602, estado_id: 2, stripe_payment_intent_id: null, email: 'cliente-legacy@example.com', nombre: 'Cliente Legacy', total: '49.95' },
    // EN (informe "añadir locale EN"): mismo mecanismo, locale='en' persistido en el draft original.
    { id: 603, estado_id: 2, stripe_payment_intent_id: 'pi_en_603', email: 'customer-en@example.com', nombre: 'EN Customer', total: '49.95' }
  ];
  const drafts = [
    {
      id: 9, stripe_payment_intent_id: 'pi_de_601', status: 'converted',
      snapshot_json: JSON.stringify({ currency: 'eur', items: [], totals: { totalCents: 4995, shippingCents: 0 }, customerData: { name: 'Kunde DE', locale: 'de', country: 'CH' } }),
      idempotency_key: 'idem-601', selections_fingerprint: 'f'.repeat(64), access_token_hash: 'a'.repeat(64),
      created_at: new Date(), updated_at: new Date(), expires_at: null
    },
    {
      id: 10, stripe_payment_intent_id: 'pi_en_603', status: 'converted',
      snapshot_json: JSON.stringify({ currency: 'eur', items: [], totals: { totalCents: 4995, shippingCents: 0 }, customerData: { name: 'EN Customer', locale: 'en', country: 'DE' } }),
      idempotency_key: 'idem-603', selections_fingerprint: 'f'.repeat(64), access_token_hash: 'a'.repeat(64),
      created_at: new Date(), updated_at: new Date(), expires_at: null
    }
  ];

  const fakePool = makeFakePoolWithDrafts({ orders, drafts });
  const router = loadFreshAdminRouter(fakePool);
  const server = await startAdminTestServer(router);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const sentMails = [];
  const restoreNodemailer = installFakeNodemailerModule(sentMails);
  try {
    // A) Pedido 601: el pago se confirmó en alemán; el cambio de estado
    // ocurre "más tarde" (misma request en este test, pero por una ruta de
    // Admin completamente distinta al pago) -- el email debe salir en DE,
    // recuperando el locale del draft original, NUNCA infiriéndolo de CH.
    const resDe = await fetch(`${base}/admin/pedidos/601/estado`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf-token' },
      body: JSON.stringify({ estado: 'Enviado' })
    });
    eq(resDe.status, 200, 'A) PUT /pedidos/601/estado -> 200');
    await new Promise(resolve => setTimeout(resolve, 0));

    const mailDe = sentMails.find(m => m.to === 'cliente-de@example.com');
    ok(mailDe, 'A) el email de cambio de estado del pedido 601 se envió');
    ok(mailDe.subject.includes('Aktualisierung deiner Bestellung'), 'A) el cambio de estado sale en DE (recuperado del draft original vía stripe_payment_intent_id), no en ES por defecto');
    ok(!/Actualización de tu pedido/.test(mailDe.subject), 'A) NUNCA se queda en español solo porque el país de envío (CH) también hablaría español... (no lo hace) -- confirma que no hay fallback silencioso a ES habiendo un locale real');

    // B) Pedido 602: legacy, sin stripe_payment_intent_id -> ningún draft
    // que consultar -> fallback coherente a ES, nunca un error ni un 500.
    const resLegacy = await fetch(`${base}/admin/pedidos/602/estado`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf-token' },
      body: JSON.stringify({ estado: 'Enviado' })
    });
    eq(resLegacy.status, 200, 'B) PUT /pedidos/602/estado (legacy, sin PI) -> 200, nunca falla por falta de locale');
    await new Promise(resolve => setTimeout(resolve, 0));

    const mailLegacy = sentMails.find(m => m.to === 'cliente-legacy@example.com');
    ok(mailLegacy, 'B) el email de cambio de estado del pedido legacy se envió');
    ok(mailLegacy.subject.includes('Actualización de tu pedido'), 'B) pedido legacy sin stripe_payment_intent_id -> fallback ES coherente (nunca infiere DE/FR de la nada)');

    // C) Pedido 603 (EN, país DE en el draft): el cambio de estado posterior
    // debe salir en inglés, recuperado del draft original -- ni ES por
    // defecto ni DE inferido del país de envío.
    const resEn = await fetch(`${base}/admin/pedidos/603/estado`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf-token' },
      body: JSON.stringify({ estado: 'Enviado' })
    });
    eq(resEn.status, 200, 'C) PUT /pedidos/603/estado -> 200');
    await new Promise(resolve => setTimeout(resolve, 0));

    const mailEn = sentMails.find(m => m.to === 'customer-en@example.com');
    ok(mailEn, 'C) el email de cambio de estado del pedido 603 se envió');
    ok(mailEn.subject.includes('Order update'), 'C) el cambio de estado sale en EN (recuperado del draft original), no en ES ni en DE (país de envío)');
  } finally {
    restoreNodemailer();
    server.close();
  }
}

// =======================================================================
async function main() {
  checkCentralNormalizeLocale();
  checkFrontendAddsNormalizedLocaleToCustomerData();
  checkValidateCustomerDataPersistsLocale();
  await checkGetDraftByPaymentIntentId();
  checkConfirmationEmailLocaleNeverFromCountry();
  await checkAdminStatusChangeRecoversLocaleFromOriginalDraft();

  console.log(`OK: ${checks} comprobaciones sobre la persistencia del locale del comprador (checkout -> draft -> confirmación -> cambio de estado posterior).`);
}

main().catch(err => {
  console.error('FALLO en check-email-locale-persistence.js:', err.message);
  process.exit(1);
});
