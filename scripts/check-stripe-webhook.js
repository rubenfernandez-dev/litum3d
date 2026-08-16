/*
  LITUM3D - Tests del webhook de Stripe (P0E-B5).

  routes/payments.js#stripeWebhookHandler NO implementa una segunda vía de
  creación de pedidos: reutiliza EXACTAMENTE services/checkout-finalization.js#finalizePaidCheckout
  (misma idempotencia por pedidos.stripe_payment_intent_id UNIQUE, misma
  validación económica contra el snapshot persistido) y el mismo
  sendConfirmationEmailAdapter que POST /api/confirm-payment. Estos tests
  prueban esa reutilización de extremo a extremo, no una implementación
  paralela.

  Tres capas de test:
  A) Firma/raw body (secciones 17/18): stripe.webhooks.constructEvent real
     (SDK de Stripe, sin red -- constructEvent es verificación criptográfica
     local) contra payloads firmados con stripe.webhooks.generateTestHeaderString.
  B) Finalización real (secciones 19-23): checkout-payment.js/checkout-finalization.js
     REALES atados a un pool/dataAccess/Stripe(payments) en memoria, mismo
     patrón que scripts/check-checkout-routes.js#makeRealServicesBoundToFakes.
     confirmPaymentHandler y stripeWebhookHandler comparten la MISMA
     checkoutFinalization (mismo pool) en los tests de idempotencia
     cross-channel, para que una duplicación real sea detectable.
  C) Route/middleware order (secciones 17/24): servidor HTTP real efímero
     con createStripeWebhookRouter() + express.json(), para probar que el
     webhook recibe Buffer y el resto de rutas siguen recibiendo JSON, y que
     no existe forma de que un body fabricado sin firma válida tenga efecto.

  Uso: node scripts/check-stripe-webhook.js
*/
const assert = require('assert');
const express = require('express');
const Stripe = require('stripe');
const paymentsModule = require('../routes/payments');
const { buildHandlers } = paymentsModule;
const realCheckoutPayment = require('../services/checkout-payment');
const realCheckoutFinalization = require('../services/checkout-finalization');
const checkoutDrafts = require('../services/checkout-drafts');

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); checks++; }

function makeReq(body) { return { body }; }
function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; }
  };
}

// --- Firma de test (sección 18) -------------------------------------------
// signingStripe es el SDK REAL de Stripe (no un doble): webhooks.constructEvent
// y webhooks.generateTestHeaderString son verificación/firma criptográfica
// puramente local, sin llamadas de red, así que es seguro usarlos en tests
// con una clave dummy.
const WEBHOOK_SECRET = 'whsec_test_secret_for_p0eb5';
const signingStripe = new Stripe('sk_test_dummy_for_signing');

function signPayload(eventObj, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify(eventObj);
  const header = signingStripe.webhooks.generateTestHeaderString({ payload, secret });
  return { payload, header };
}

function buildEvent({ id, type, paymentIntent }) {
  return { id, object: 'event', type, data: { object: paymentIntent } };
}

function makeWebhookReq(payload, header) {
  return { body: Buffer.from(payload), headers: header ? { 'stripe-signature': header } : {} };
}

async function withWebhookSecret(fn) {
  const prev = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = prev;
  }
}

// --- Fixtures reales (mismo patrón que scripts/check-checkout-routes.js) --
const PRODUCTS = { 8: { id: 8, nombre: 'Litofanía Circular', precio: '50.00', activo: 1 } };

function fakePricingDataAccess() {
  return {
    async getProduct(productId) { return PRODUCTS[productId] || null; },
    async getModel() { return null; },
    async getVariantOptions() { return []; }
  };
}

function makeFakeDraftsDataAccess() {
  const rows = new Map();
  let nextId = 1;
  function checkUnique(field, value, excludeId) {
    if (value === null || value === undefined) return;
    for (const row of rows.values()) {
      if (row.id === excludeId) continue;
      if (row[field] === value) {
        const err = new Error(`Duplicate entry '${value}' for key 'checkout_drafts.unique_checkout_drafts_${field}'`);
        err.code = 'ER_DUP_ENTRY'; err.sqlMessage = err.message;
        throw err;
      }
    }
  }
  return {
    async insertDraft({ idempotencyKey, selectionsFingerprint, accessTokenHash, snapshotJson, status, expiresAt }) {
      checkUnique('idempotency_key', idempotencyKey);
      checkUnique('access_token_hash', accessTokenHash);
      const id = nextId++;
      const now = new Date();
      rows.set(id, { id, idempotency_key: idempotencyKey, selections_fingerprint: selectionsFingerprint, access_token_hash: accessTokenHash, stripe_payment_intent_id: null, snapshot_json: snapshotJson, status, created_at: now, updated_at: now, expires_at: expiresAt });
      return id;
    },
    async findById(id) { return rows.get(id) || null; },
    async findByIdempotencyKey(key) { for (const row of rows.values()) if (row.idempotency_key === key) return row; return null; },
    async findByAccessTokenHash(hash) { for (const row of rows.values()) if (row.access_token_hash === hash) return row; return null; },
    async updateSnapshotIfStatusIn(id, snapshotJson, allowedStatuses) {
      const row = rows.get(id); if (!row) return 0;
      if (!allowedStatuses.includes(row.status)) return 0;
      row.snapshot_json = snapshotJson; row.updated_at = new Date();
      return 1;
    },
    async updateStatus(id, status) { const row = rows.get(id); if (row) { row.status = status; row.updated_at = new Date(); } },
    async attachStripePaymentIntent(id, paymentIntentId, status) {
      checkUnique('stripe_payment_intent_id', paymentIntentId, id);
      const row = rows.get(id); if (row) { row.stripe_payment_intent_id = paymentIntentId; row.status = status; row.updated_at = new Date(); }
    },
    _rows: rows
  };
}

// Doble de Stripe para el LADO de creación/recuperación de PaymentIntents
// (services/checkout-payment.js). Distinto de signingStripe (SDK real, usado
// solo para constructEvent/generateTestHeaderString): en producción ambos
// son el mismo cliente Stripe real, pero aquí se separan porque uno simula
// paymentIntents.create/retrieve y el otro necesita criptografía real.
function makeFakePaymentsStripe() {
  const byIdempotencyKey = new Map();
  const byId = new Map();
  let counter = 1;
  return {
    paymentIntents: {
      async create(params, requestOptions = {}) {
        const idemKey = requestOptions.idempotencyKey;
        if (idemKey && byIdempotencyKey.has(idemKey)) return byIdempotencyKey.get(idemKey);
        const id = `pi_test_${counter++}`;
        const pi = { id, status: 'requires_payment_method', amount: params.amount, currency: params.currency, metadata: params.metadata || {}, client_secret: `${id}_secret` };
        if (idemKey) byIdempotencyKey.set(idemKey, pi);
        byId.set(id, pi);
        return pi;
      },
      async retrieve(id) {
        const pi = byId.get(id);
        if (!pi) { const e = new Error('No such payment_intent'); e.code = 'resource_missing'; throw e; }
        return pi;
      }
    },
    _setStatus(id, status) { const pi = byId.get(id); if (pi) pi.status = status; }
  };
}

// Pool mysql2 transaccional en memoria, mismo patrón que
// scripts/check-checkout-finalization.js / check-checkout-routes.js.
function makeFakePool(draftsStore) {
  const state = { pedidos: new Map(), detallePedidos: new Map(), detalleImagenes: new Map(), nextPedidoId: 1, nextDetalleId: 1, nextImagenId: 1 };
  function cloneMap(m) { return new Map([...m].map(([k, v]) => [k, { ...v }])); }
  function snapshotState() { return { pedidos: cloneMap(state.pedidos), detallePedidos: cloneMap(state.detallePedidos), detalleImagenes: cloneMap(state.detalleImagenes), nextPedidoId: state.nextPedidoId, nextDetalleId: state.nextDetalleId, nextImagenId: state.nextImagenId }; }
  function restoreState(s) { Object.assign(state, s); }
  function checkPedidoUnique(pi) {
    if (!pi) return;
    for (const row of state.pedidos.values()) {
      if (row.stripe_payment_intent_id === pi) { const err = new Error(`Duplicate entry '${pi}'`); err.code = 'ER_DUP_ENTRY'; err.sqlMessage = `...stripe_payment_intent_id...`; throw err; }
    }
  }
  async function runQuery(sql, params = []) {
    if (sql.includes('FROM checkout_drafts WHERE id = ? FOR UPDATE')) {
      const row = draftsStore._rows.get(params[0]);
      return [row ? [{ ...row }] : []];
    }
    if (sql.includes('SELECT id FROM pedidos WHERE stripe_payment_intent_id')) {
      const found = [...state.pedidos.values()].find(r => r.stripe_payment_intent_id === params[0]);
      return [found ? [{ id: found.id }] : []];
    }
    if (sql.startsWith('INSERT INTO pedidos')) {
      const [usuario_id, estado_id, total, customer_name, customer_email, customer_phone, customer_address, customer_city, customer_zip, customer_country, notas, stripe_payment_intent_id, currency] = params;
      checkPedidoUnique(stripe_payment_intent_id);
      const id = state.nextPedidoId++;
      state.pedidos.set(id, { id, usuario_id, estado_id, total, customer_name, customer_email, customer_phone, customer_address, customer_city, customer_zip, customer_country, notas, stripe_payment_intent_id, currency });
      return [{ insertId: id }];
    }
    if (sql.startsWith('INSERT INTO detalle_pedidos')) {
      const id = state.nextDetalleId++;
      state.detallePedidos.set(id, { id });
      return [{ insertId: id }];
    }
    if (sql.startsWith('INSERT INTO detalle_pedido_imagenes')) {
      const id = state.nextImagenId++;
      return [{ insertId: id }];
    }
    if (sql.startsWith('UPDATE checkout_drafts SET status')) {
      const [status, id] = params;
      const row = draftsStore._rows.get(id);
      if (row) row.status = status;
      return [{ affectedRows: row ? 1 : 0 }];
    }
    throw new Error(`Fake pool: consulta no reconocida: ${sql}`);
  }
  return {
    async query(sql, params) { return runQuery(sql, params); },
    async getConnection() {
      let txSnapshot = null;
      return {
        async beginTransaction() { txSnapshot = snapshotState(); },
        async query(sql, params) { return runQuery(sql, params); },
        async commit() { txSnapshot = null; },
        async rollback() { if (txSnapshot) restoreState(txSnapshot); },
        release() {}
      };
    },
    _state: state
  };
}

function generateAccessToken() { return checkoutDrafts.generateAccessToken(); }

// Ata checkout-payment.js/checkout-finalization.js REALES a fixtures en
// memoria compartidas: el mismo "world" se usa para construir tanto los
// handlers de confirm-payment como los del webhook en los tests de
// idempotencia cross-channel (sección 21), para que ambos caminos escriban
// en el MISMO pool y una duplicación real sea detectable.
function makeWorld() {
  const pricingDataAccess = fakePricingDataAccess();
  const draftsDataAccess = makeFakeDraftsDataAccess();
  const pool = makeFakePool(draftsDataAccess);
  const paymentsStripe = makeFakePaymentsStripe();

  const checkoutPayment = {
    async prepareCanonicalCheckout(args, options = {}) {
      return realCheckoutPayment.prepareCanonicalCheckout(args, { ...options, pricingDataAccess, draftsDataAccess, stripe: paymentsStripe });
    }
  };
  const checkoutFinalization = {
    async finalizePaidCheckout(paymentIntent, options = {}) {
      return realCheckoutFinalization.finalizePaidCheckout(paymentIntent, { ...options, pool, draftsDataAccess });
    }
  };
  return { checkoutPayment, checkoutFinalization, paymentsStripe, pool, draftsDataAccess };
}

async function createSucceededPaymentIntent(world, { idempotencyKey }) {
  const accessToken = generateAccessToken();
  const result = await world.checkoutPayment.prepareCanonicalCheckout({
    idempotencyKey, accessToken, selections: [{ productId: 8, quantity: 1 }]
  });
  world.paymentsStripe._setStatus(result.paymentIntentId, 'succeeded');
  return world.paymentsStripe.paymentIntents.retrieve(result.paymentIntentId);
}

// =======================================================================
// A) Sección 18 - Verificación de firma (SDK real, sin red)
// =======================================================================
async function checkSignatureVerification() {
  await withWebhookSecret(async () => {
    const world = makeWorld();
    const emailCalls = [];
    const handlers = buildHandlers({ checkoutFinalization: world.checkoutFinalization, stripe: signingStripe, sendConfirmationEmailsFn: async () => emailCalls.push(1) });

    const pi = { id: 'pi_sig_test', status: 'canceled', amount: 1000, currency: 'eur', metadata: {} };
    const event = buildEvent({ id: 'evt_sig_1', type: 'payment_intent.canceled', paymentIntent: pi });
    const { payload, header } = signPayload(event);

    // A. payload original + secret correcto + firma válida -> aceptado.
    {
      const res = makeRes();
      await handlers.stripeWebhookHandler(makeWebhookReq(payload, header), res);
      eq(res.statusCode, 200, 'firma válida -> 200');
      eq(res.body.received, true, 'firma válida -> received:true');
    }

    // B. payload modificado + MISMA firma -> 400.
    {
      const tampered = payload.replace('"amount":1000', '"amount":1');
      const res = makeRes();
      await handlers.stripeWebhookHandler(makeWebhookReq(tampered, header), res);
      eq(res.statusCode, 400, 'payload modificado con la misma firma -> 400');
      eq(res.body.received, false, 'payload modificado -> received:false');
    }

    // C. firma generada con un secret INCORRECTO -> 400.
    {
      const wrongHeader = signingStripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_wrong_secret' });
      const res = makeRes();
      await handlers.stripeWebhookHandler(makeWebhookReq(payload, wrongHeader), res);
      eq(res.statusCode, 400, 'firma generada con secret incorrecto -> 400');
    }

    // D. sin header stripe-signature -> 400.
    {
      const res = makeRes();
      await handlers.stripeWebhookHandler(makeWebhookReq(payload, null), res);
      eq(res.statusCode, 400, 'sin header stripe-signature -> 400');
    }

    eq(emailCalls.length, 0, 'ningún caso de este test debe disparar un email (evento canceled, o rechazado antes de procesar)');
  });

  // E. STRIPE_WEBHOOK_SECRET ausente -> fail-closed, 400, NUNCA se procesa
  // el evento aunque la firma en sí sea perfectamente válida.
  {
    const prev = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    try {
      const world = makeWorld();
      const handlers = buildHandlers({ checkoutFinalization: world.checkoutFinalization, stripe: signingStripe, sendConfirmationEmailsFn: async () => {} });
      const pi = { id: 'pi_no_secret', status: 'canceled', amount: 1000, currency: 'eur', metadata: {} };
      const event = buildEvent({ id: 'evt_no_secret', type: 'payment_intent.canceled', paymentIntent: pi });
      const { payload, header } = signPayload(event);
      const res = makeRes();
      await handlers.stripeWebhookHandler(makeWebhookReq(payload, header), res);
      eq(res.statusCode, 400, 'STRIPE_WEBHOOK_SECRET no configurado -> 400 fail-closed, sin fallback inseguro');
    } finally {
      if (prev === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
      else process.env.STRIPE_WEBHOOK_SECRET = prev;
    }
  }
}

// =======================================================================
// B) Sección 19 - payment_intent.succeeded finaliza vía finalizePaidCheckout real
// =======================================================================
async function checkWebhookSucceededCreatesOrder() {
  await withWebhookSecret(async () => {
    const world = makeWorld();
    const emailCalls = [];
    const handlers = buildHandlers({ checkoutFinalization: world.checkoutFinalization, stripe: signingStripe, sendConfirmationEmailsFn: async (...args) => emailCalls.push(args) });

    const pi = await createSucceededPaymentIntent(world, { idempotencyKey: 'wh-success-1' });
    const event = buildEvent({ id: 'evt_success_1', type: 'payment_intent.succeeded', paymentIntent: pi });
    const { payload, header } = signPayload(event);

    const res = makeRes();
    await handlers.stripeWebhookHandler(makeWebhookReq(payload, header), res);

    eq(res.statusCode, 200, 'payment_intent.succeeded válido y consistente -> 200');
    eq(res.body.received, true, 'respuesta trae received:true');
    eq(Object.keys(res.body).sort().join(','), 'received', 'la respuesta del webhook NO expone snapshot/orderId/customerData/PII (sección 11)');
    eq(world.pool._state.pedidos.size, 1, 'debe haberse creado exactamente un pedido');
    eq(emailCalls.length, 1, 'debe haberse enviado exactamente un email de confirmación');
  });
}

// =======================================================================
// B) Sección 20 - Stripe reenvía el MISMO evento varias veces
// =======================================================================
async function checkWebhookRetrySameEventIsIdempotent() {
  await withWebhookSecret(async () => {
    const world = makeWorld();
    const emailCalls = [];
    const handlers = buildHandlers({ checkoutFinalization: world.checkoutFinalization, stripe: signingStripe, sendConfirmationEmailsFn: async () => emailCalls.push(1) });

    const pi = await createSucceededPaymentIntent(world, { idempotencyKey: 'wh-retry-1' });
    const event = buildEvent({ id: 'evt_retry_1', type: 'payment_intent.succeeded', paymentIntent: pi });
    const { payload, header } = signPayload(event);

    const res1 = makeRes();
    await handlers.stripeWebhookHandler(makeWebhookReq(payload, header), res1);
    eq(res1.statusCode, 200, 'primera entrega del evento -> 200 (created:true internamente)');

    const res2 = makeRes();
    await handlers.stripeWebhookHandler(makeWebhookReq(payload, header), res2);
    eq(res2.statusCode, 200, 'Stripe reenvía el MISMO evento -> 200 también (created:false internamente)');

    eq(world.pool._state.pedidos.size, 1, 'un solo pedido tras reenviar el mismo evento dos veces');
    eq(emailCalls.length, 1, 'un solo email tras reenviar el mismo evento dos veces');
  });
}

// =======================================================================
// B) Sección 21 - Idempotencia cross-channel (browser <-> webhook), ambos
// órdenes posibles, con la MISMA capa de finalización real (mismo pool).
// =======================================================================
async function checkCrossChannelIdempotency() {
  // Caso 1: POST /api/confirm-payment crea el pedido primero; el webhook llega después.
  await withWebhookSecret(async () => {
    const world = makeWorld();
    const emailCalls = [];
    const sendConfirmationEmailsFn = async () => emailCalls.push(1);
    const confirmHandlers = buildHandlers({ checkoutPayment: world.checkoutPayment, checkoutFinalization: world.checkoutFinalization, stripe: world.paymentsStripe, sendConfirmationEmailsFn });
    const webhookHandlers = buildHandlers({ checkoutFinalization: world.checkoutFinalization, stripe: signingStripe, sendConfirmationEmailsFn });

    const accessToken = generateAccessToken();
    const prepRes = makeRes();
    await confirmHandlers.createPaymentIntentHandler(makeReq({ idempotencyKey: 'cross-1', accessToken, selections: [{ productId: 8, quantity: 1 }] }), prepRes);
    const { paymentIntentId } = prepRes.body;
    world.paymentsStripe._setStatus(paymentIntentId, 'succeeded');

    const confirmRes = makeRes();
    await confirmHandlers.confirmPaymentHandler(makeReq({ paymentIntentId }), confirmRes);
    eq(confirmRes.statusCode, 200, 'caso 1: confirm-payment -> 200');
    eq(confirmRes.body.created, true, 'caso 1: confirm-payment (navegador) crea el pedido primero');

    const pi = await world.paymentsStripe.paymentIntents.retrieve(paymentIntentId);
    const event = buildEvent({ id: 'evt_cross_1', type: 'payment_intent.succeeded', paymentIntent: pi });
    const { payload, header } = signPayload(event);
    const whRes = makeRes();
    await webhookHandlers.stripeWebhookHandler(makeWebhookReq(payload, header), whRes);
    eq(whRes.statusCode, 200, 'caso 1: webhook después del navegador -> 200 (no duplica)');

    eq(world.pool._state.pedidos.size, 1, 'caso 1: un solo pedido tras confirm-payment + webhook');
    eq(emailCalls.length, 1, 'caso 1: un solo email tras confirm-payment + webhook');
  });

  // Caso 2: el webhook crea el pedido primero; POST /api/confirm-payment llega después.
  await withWebhookSecret(async () => {
    const world = makeWorld();
    const emailCalls = [];
    const sendConfirmationEmailsFn = async () => emailCalls.push(1);
    const confirmHandlers = buildHandlers({ checkoutPayment: world.checkoutPayment, checkoutFinalization: world.checkoutFinalization, stripe: world.paymentsStripe, sendConfirmationEmailsFn });
    const webhookHandlers = buildHandlers({ checkoutFinalization: world.checkoutFinalization, stripe: signingStripe, sendConfirmationEmailsFn });

    const pi = await createSucceededPaymentIntent(world, { idempotencyKey: 'cross-2' });
    const event = buildEvent({ id: 'evt_cross_2', type: 'payment_intent.succeeded', paymentIntent: pi });
    const { payload, header } = signPayload(event);
    const whRes = makeRes();
    await webhookHandlers.stripeWebhookHandler(makeWebhookReq(payload, header), whRes);
    eq(whRes.statusCode, 200, 'caso 2: webhook primero -> 200');

    const confirmRes = makeRes();
    await confirmHandlers.confirmPaymentHandler(makeReq({ paymentIntentId: pi.id }), confirmRes);
    eq(confirmRes.statusCode, 200, 'caso 2: confirm-payment (navegador) después del webhook -> 200');
    eq(confirmRes.body.created, false, 'caso 2: confirm-payment después del webhook -> created:false, no duplica');

    eq(world.pool._state.pedidos.size, 1, 'caso 2: un solo pedido tras webhook + confirm-payment');
    eq(emailCalls.length, 1, 'caso 2: un solo email tras webhook + confirm-payment');
  });
}

// =======================================================================
// B) Sección 22 - payment_failed / canceled / evento desconocido
// =======================================================================
async function checkFailedCanceledAndUnknownEvents() {
  await withWebhookSecret(async () => {
    const world = makeWorld();
    const emailCalls = [];
    const handlers = buildHandlers({ checkoutFinalization: world.checkoutFinalization, stripe: signingStripe, sendConfirmationEmailsFn: async () => emailCalls.push(1) });

    for (const type of ['payment_intent.payment_failed', 'payment_intent.canceled']) {
      const pi = { id: `pi_${type}`, status: type === 'payment_intent.canceled' ? 'canceled' : 'requires_payment_method', amount: 1000, currency: 'eur', metadata: { checkoutDraftId: '999' } };
      const event = buildEvent({ id: `evt_${type}`, type, paymentIntent: pi });
      const { payload, header } = signPayload(event);
      const res = makeRes();
      await handlers.stripeWebhookHandler(makeWebhookReq(payload, header), res);
      eq(res.statusCode, 200, `${type} -> 200`);
    }
    eq(world.pool._state.pedidos.size, 0, 'payment_failed/canceled no deben crear ningún pedido');

    // Evento válidamente firmado pero de un tipo que no manejamos -> 200 sin acción.
    const unknownEvent = buildEvent({ id: 'evt_unknown', type: 'charge.refunded', paymentIntent: { id: 'ch_x' } });
    const { payload: p2, header: h2 } = signPayload(unknownEvent);
    const res2 = makeRes();
    await handlers.stripeWebhookHandler(makeWebhookReq(p2, h2), res2);
    eq(res2.statusCode, 200, 'evento desconocido válidamente firmado -> 200 (evita reintentos innecesarios de Stripe)');
    eq(world.pool._state.pedidos.size, 0, 'evento desconocido no debe crear ningún pedido');

    eq(emailCalls.length, 0, 'payment_failed/canceled/evento desconocido NUNCA deben enviar email de confirmación');
  });
}

// =======================================================================
// B) Sección 23 - PI ajeno (sin checkoutDraftId) y anomalía de integridad definitiva
// =======================================================================
async function checkForeignAndIntegrityFailurePaymentIntents() {
  await withWebhookSecret(async () => {
    const world = makeWorld();
    const emailCalls = [];
    const handlers = buildHandlers({ checkoutFinalization: world.checkoutFinalization, stripe: signingStripe, sendConfirmationEmailsFn: async () => emailCalls.push(1) });

    // A. succeeded sin metadata.checkoutDraftId -> ignorado de forma segura.
    {
      const pi = { id: 'pi_foreign', status: 'succeeded', amount: 1000, currency: 'eur', metadata: {} };
      const event = buildEvent({ id: 'evt_foreign', type: 'payment_intent.succeeded', paymentIntent: pi });
      const { payload, header } = signPayload(event);
      const res = makeRes();
      await handlers.stripeWebhookHandler(makeWebhookReq(payload, header), res);
      eq(res.statusCode, 200, 'PI succeeded sin metadata.checkoutDraftId -> 200 (ignorado, nunca pedido)');
      eq(world.pool._state.pedidos.size, 0, 'PI ajeno no debe crear ningún pedido');
    }

    // B. checkoutDraftId presente pero el PaymentIntent es inconsistente con
    // su snapshot (amount alterado) -> anomalía de integridad DEFINITIVA:
    // política de la sección 12/23 -> 200 acknowledged (nunca 500 -- un
    // reintento del mismo evento nunca arreglará esta inconsistencia), pero
    // NUNCA crea pedido.
    {
      const pi = await createSucceededPaymentIntent(world, { idempotencyKey: 'wh-integrity-1' });
      const tamperedPi = { ...pi, amount: pi.amount + 1 };
      const event = buildEvent({ id: 'evt_integrity_1', type: 'payment_intent.succeeded', paymentIntent: tamperedPi });
      const { payload, header } = signPayload(event);
      const res = makeRes();
      await handlers.stripeWebhookHandler(makeWebhookReq(payload, header), res);
      eq(res.statusCode, 200, 'amount mismatch (anomalía de integridad definitiva) -> 200 acknowledged, no 500 (nunca se resolvería con un retry)');
      eq(world.pool._state.pedidos.size, 0, 'anomalía de integridad definitiva nunca debe crear un pedido');
    }

    eq(emailCalls.length, 0, 'ni el PI ajeno ni la anomalía de integridad deben enviar ningún email');
  });
}

// =======================================================================
// B) Sección 12 - fallo TRANSITORIO (DB) durante finalización -> 5xx, para
// que Stripe SÍ reintente (a diferencia de una anomalía de integridad
// definitiva, que responde 200).
// =======================================================================
async function checkTransientFailureReturns5xx() {
  await withWebhookSecret(async () => {
    const world = makeWorld();
    const emailCalls = [];
    // checkoutFinalization que simula un error transitorio de DB (timeout),
    // no un error de dominio con nombre reconocido por isDefinitiveIntegrityError.
    const transientDbError = Object.assign(new Error('ETIMEDOUT: connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' });
    const checkoutFinalization = { async finalizePaidCheckout() { throw transientDbError; } };
    const handlers = buildHandlers({ checkoutFinalization, stripe: signingStripe, sendConfirmationEmailsFn: async () => emailCalls.push(1) });

    const pi = { id: 'pi_transient', status: 'succeeded', amount: 1000, currency: 'eur', metadata: { checkoutDraftId: '1' } };
    const event = buildEvent({ id: 'evt_transient_1', type: 'payment_intent.succeeded', paymentIntent: pi });
    const { payload, header } = signPayload(event);
    const res = makeRes();
    await handlers.stripeWebhookHandler(makeWebhookReq(payload, header), res);

    eq(res.statusCode, 500, 'fallo transitorio de DB durante finalización -> 5xx, para que Stripe reintente el evento');
    eq(res.body.received, false, 'fallo transitorio -> received:false');
    eq(emailCalls.length, 0, 'un fallo transitorio nunca debe haber disparado un email');
  });
}

// =======================================================================
// C) Secciones 17/24 - orden real de middleware (raw vs JSON) + body
// malicioso sin firma sobre un servidor HTTP real.
// =======================================================================
async function checkRouteOrderAndMaliciousBody() {
  let capturedBodyIsBuffer = null;
  const stripeSpy = { webhooks: { constructEvent: (body) => { capturedBodyIsBuffer = Buffer.isBuffer(body); throw new Error('stop-for-test: firma no verificada de verdad en este test, solo se inspecciona el tipo del body'); } } };

  const app = express();
  // Mismo orden que server.js: el router del webhook (con su propio
  // express.raw dentro) se monta ANTES de express.json() global.
  app.use('/api/stripe/webhook', paymentsModule.createStripeWebhookRouter({ stripe: stripeSpy }));
  app.use(express.json());
  let capturedJsonBody = null;
  app.post('/api/probe-json', (req, res) => { capturedJsonBody = req.body; res.json({ ok: true }); });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;

  try {
    await withWebhookSecret(async () => {
      // Sección 17: el webhook recibe el body como Buffer, NUNCA como
      // objeto ya parseado por express.json() -- probado levantando el
      // route stack real, no con una búsqueda textual de "express.raw".
      const webhookResp = await fetch(`http://127.0.0.1:${port}/api/stripe/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
        body: JSON.stringify({ type: 'payment_intent.succeeded', data: { object: {} } })
      });
      eq(webhookResp.status, 400, 'stripeSpy.constructEvent lanza (firma no verificada de verdad aquí) -> 400');
      ok(capturedBodyIsBuffer === true, 'CRÍTICO: /api/stripe/webhook recibe el body como Buffer RAW exacto, nunca ya parseado');

      // Sección 17: el resto de rutas sigue recibiendo JSON parseado con normalidad.
      const probeResp = await fetch(`http://127.0.0.1:${port}/api/probe-json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ foo: 'bar', n: 1 })
      });
      eq(probeResp.status, 200, 'ruta normal tras el webhook -> 200');
      ok(capturedJsonBody && typeof capturedJsonBody === 'object' && capturedJsonBody.foo === 'bar', 'otras rutas siguen recibiendo un objeto JSON ya parseado (express.json() global sigue intacto)');

      // Sección 24: body JSON fabricado a mano, SIN stripe-signature -> 400,
      // nunca se procesa como si viniera de Stripe.
      const maliciousResp = await fetch(`http://127.0.0.1:${port}/api/stripe/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { id: 'pi_evil', metadata: { checkoutDraftId: '1' } } } })
      });
      eq(maliciousResp.status, 400, 'JSON fabricado a mano sin stripe-signature -> 400, sin ningún efecto');
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// =======================================================================
async function main() {
  console.log('P0E-B5 - verificación de firma del webhook (SDK real, sin red)');
  await checkSignatureVerification();
  console.log('P0E-B5 - payment_intent.succeeded finaliza vía finalizePaidCheckout real');
  await checkWebhookSucceededCreatesOrder();
  console.log('P0E-B5 - Stripe reenvía el mismo evento varias veces (idempotencia)');
  await checkWebhookRetrySameEventIsIdempotent();
  console.log('P0E-B5 - idempotencia cross-channel navegador <-> webhook (ambos órdenes)');
  await checkCrossChannelIdempotency();
  console.log('P0E-B5 - payment_failed/canceled/evento desconocido: sin pedido, sin email');
  await checkFailedCanceledAndUnknownEvents();
  console.log('P0E-B5 - PI ajeno y anomalía de integridad definitiva');
  await checkForeignAndIntegrityFailurePaymentIntents();
  console.log('P0E-B5 - fallo transitorio de DB -> 5xx (permite retry de Stripe)');
  await checkTransientFailureReturns5xx();
  console.log('P0E-B5 - orden real de middleware (raw vs JSON) + body malicioso sin firma');
  await checkRouteOrderAndMaliciousBody();
  console.log(`OK: ${checks} comprobaciones sobre el webhook de Stripe (routes/payments.js#stripeWebhookHandler).`);
}

main().catch(err => { console.error('FALLO:', err); process.exit(1); });
