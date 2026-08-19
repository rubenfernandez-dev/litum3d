/*
  LITUM3D - Tests de las rutas públicas de checkout canónico (P0E-B4B).

  Dos grupos de comprobaciones:

  A) "Route layer": handlers construidos con checkoutPayment/checkoutFinalization
     completamente falsos (canned responses / errores de dominio reales
     lanzados a mano). Prueban SOLO la capa HTTP: allowlist estricta del
     body, mapeo de errores de dominio -> status code, forma del DTO
     público (nada de access_token_hash/selections_fingerprint/customerData
     se filtra). Sin Stripe real, sin BD real.

  B) "End-to-end vía la ruta": los MISMOS handlers, pero con
     services/checkout-payment.js y services/checkout-finalization.js REALES,
     atados a un dataAccess/pool en memoria y un doble de Stripe (mismo
     patrón que scripts/check-checkout-payment.js / check-checkout-finalization.js).
     Prueba que la cadena completa -- HTTP -> servicio real -> motor de
     pricing real -- rechaza selections maliciosas (price/total/currency) y
     que el flujo feliz completo (prepare -> customer-data -> confirm)
     funciona de extremo a extremo sin BD/Stripe reales.

  Uso: node scripts/check-checkout-routes.js
*/
const assert = require('assert');
const { buildHandlers } = require('../routes/payments');
const realCheckoutPayment = require('../services/checkout-payment');
const realCheckoutFinalization = require('../services/checkout-finalization');
const { PricingValidationError } = require('../services/pricing');
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

// =======================================================================
// Grupo A: capa HTTP con servicios completamente falsos
// =======================================================================
async function checkRouteLayerHttpMapping() {
  // --- allowlist estricta del body ---
  {
    const handlers = buildHandlers({ checkoutPayment: {}, checkoutFinalization: {}, stripe: {} });
    const res = makeRes();
    await handlers.createPaymentIntentHandler(makeReq({
      idempotencyKey: 'k', accessToken: 'a'.repeat(64), selections: [], price: 0.01
    }), res);
    eq(res.statusCode, 400, 'create-payment-intent: campo extra "price" en el body -> 400');
    eq(res.body.ok, false, 'respuesta de error trae ok:false');
    eq(res.body.code, 'validation_error', 'código de error correcto para allowlist');
  }
  {
    const handlers = buildHandlers({ checkoutPayment: {}, checkoutFinalization: {}, stripe: {} });
    const res = makeRes();
    await handlers.createPaymentIntentHandler(makeReq({
      idempotencyKey: 'k', accessToken: 'a'.repeat(64), selections: [], currency: 'chf'
    }), res);
    eq(res.statusCode, 400, 'create-payment-intent: campo extra "currency" en el body -> 400 (nunca se usa para decidir moneda)');
  }
  {
    const handlers = buildHandlers({ checkoutPayment: {}, checkoutFinalization: {}, stripe: {} });
    const res = makeRes();
    await handlers.confirmPaymentHandler(makeReq({
      paymentIntentId: 'pi_x', cart: [{ price: 0.01 }], total: 1, customerData: { name: 'x' }
    }), res);
    eq(res.statusCode, 400, 'confirm-payment: body con cart/total/customerData -> 400 (allowlist solo permite paymentIntentId)');
  }
  {
    const handlers = buildHandlers({ checkoutPayment: {}, checkoutFinalization: {}, stripe: {} });
    const res = makeRes();
    await handlers.updateCustomerDataHandler(makeReq({
      accessToken: 'a'.repeat(64), customerData: { name: 'Ana' }, extra: 'no'
    }), res);
    eq(res.statusCode, 400, 'customer-data: campo extra en el body -> 400');
  }
  // country dentro de customerData: SÍ se admite en el allowlist del body
  // (ya no es "campo extra") -- qué códigos concretos se aceptan lo decide
  // el propio checkoutDrafts (validateCustomerData) contra la allowlist de
  // config/checkout-countries.js, no este allowlist de nombres de campo. Se
  // comprueba en el grupo B (end-to-end) tanto el país válido como el inválido.

  // --- paymentIntentId con formato inválido ---
  {
    const handlers = buildHandlers({ checkoutPayment: {}, checkoutFinalization: {}, stripe: {} });
    const res = makeRes();
    await handlers.confirmPaymentHandler(makeReq({ paymentIntentId: 'DROP TABLE pedidos;' }), res);
    eq(res.statusCode, 400, 'confirm-payment: paymentIntentId con formato inválido -> 400');
  }

  // --- mapeo de errores de dominio -> status code ---
  const cases = [
    [new checkoutDrafts.DraftValidationError('x'), 400],
    [new checkoutDrafts.DraftIdempotencyConflictError('x', {}), 409],
    [new checkoutDrafts.DraftAccessDeniedError('x'), 403],
    [new checkoutDrafts.DraftStateError('x', {}), 409],
    [new checkoutDrafts.DraftNotFoundError('x', {}), 404],
    [new PricingValidationError('x'), 400]
  ];
  for (const [err, expectedStatus] of cases) {
    const handlers = buildHandlers({
      checkoutPayment: { prepareCanonicalCheckout: async () => { throw err; } },
      checkoutFinalization: {},
      stripe: {}
    });
    const res = makeRes();
    await handlers.createPaymentIntentHandler(makeReq({ idempotencyKey: 'k', accessToken: 'a'.repeat(64), selections: [{ productId: 1, quantity: 1 }] }), res);
    eq(res.statusCode, expectedStatus, `${err.constructor.name} debe mapear a HTTP ${expectedStatus}`);
    ok(!JSON.stringify(res.body).includes('a'.repeat(64)), `${err.constructor.name}: la respuesta NO debe incluir el accessToken`);
  }

  // PaymentIntentValidationError: not_succeeded -> 409, resto -> 422
  {
    const err = Object.assign(new Error('x'), { name: 'PaymentIntentValidationError', reason: 'not_succeeded' });
    const handlers = buildHandlers({
      checkoutPayment: {},
      checkoutFinalization: { finalizePaidCheckout: async () => { throw err; } },
      stripe: { paymentIntents: { retrieve: async () => ({ id: 'pi_x', status: 'processing' }) } }
    });
    const res = makeRes();
    await handlers.confirmPaymentHandler(makeReq({ paymentIntentId: 'pi_x' }), res);
    eq(res.statusCode, 409, 'PaymentIntentValidationError(not_succeeded) -> 409');
  }
  {
    const err = Object.assign(new Error('x'), { name: 'PaymentIntentValidationError', reason: 'amount_mismatch' });
    const handlers = buildHandlers({
      checkoutPayment: {},
      checkoutFinalization: { finalizePaidCheckout: async () => { throw err; } },
      stripe: { paymentIntents: { retrieve: async () => ({ id: 'pi_x', status: 'succeeded' }) } }
    });
    const res = makeRes();
    await handlers.confirmPaymentHandler(makeReq({ paymentIntentId: 'pi_x' }), res);
    eq(res.statusCode, 422, 'PaymentIntentValidationError(amount_mismatch) -> 422');
  }
  // FinalizationIntegrityError -> 422
  {
    const err = Object.assign(new Error('x'), { name: 'FinalizationIntegrityError' });
    const handlers = buildHandlers({
      checkoutPayment: {},
      checkoutFinalization: { finalizePaidCheckout: async () => { throw err; } },
      stripe: { paymentIntents: { retrieve: async () => ({ id: 'pi_x', status: 'succeeded' }) } }
    });
    const res = makeRes();
    await handlers.confirmPaymentHandler(makeReq({ paymentIntentId: 'pi_x' }), res);
    eq(res.statusCode, 422, 'FinalizationIntegrityError -> 422');
  }
  // Stripe transitorio -> 502
  {
    const stripeErr = Object.assign(new Error('conn'), { type: 'StripeConnectionError' });
    const handlers = buildHandlers({
      checkoutPayment: {},
      checkoutFinalization: {},
      stripe: { paymentIntents: { retrieve: async () => { throw stripeErr; } } }
    });
    const res = makeRes();
    await handlers.confirmPaymentHandler(makeReq({ paymentIntentId: 'pi_x' }), res);
    eq(res.statusCode, 502, 'StripeConnectionError -> 502');
  }

  // --- DTO público: forma exacta, sin campos internos ---
  {
    const fakeSnapshot = {
      currency: 'eur',
      totals: { subtotalCents: 1000, shippingCents: 0, totalCents: 1000, netCents: 826, taxCents: 174 },
      customerData: { name: 'Ana', email: 'a@b.com', phone: '1', address: '2', city: '3', zip: '4' },
      items: [{ productId: 8, productName: 'X', quantity: 1, modelName: null, variantSelections: [], extras: { upscale: false, qr: false, adapter: false, qrMessage: '' }, unitPriceCents: 1000, images: ['foo'], notes: 'nota' }]
    };
    const handlers = buildHandlers({
      checkoutPayment: {
        prepareCanonicalCheckout: async () => ({
          draftId: 42, reused: false, clientSecret: 'cs_test', paymentIntentId: 'pi_test', paymentIntentStatus: 'requires_payment_method', snapshot: fakeSnapshot
        })
      },
      checkoutFinalization: {},
      stripe: {}
    });
    const res = makeRes();
    await handlers.createPaymentIntentHandler(makeReq({ idempotencyKey: 'k', accessToken: 'a'.repeat(64), selections: [{ productId: 8, quantity: 1 }] }), res);
    eq(res.statusCode, 200, 'happy path -> 200');
    const dto = res.body;
    eq(dto.draftId, 42, 'DTO expone draftId');
    eq(dto.currency, 'eur', 'DTO expone currency del snapshot');
    ok(dto.totals && dto.totals.totalCents === 1000, 'DTO expone totals del snapshot');
    ok(!('customerData' in dto), 'DTO NO debe incluir customerData');
    ok(!('access_token_hash' in dto) && !JSON.stringify(dto).includes('access_token_hash'), 'DTO NO debe incluir access_token_hash');
    ok(!('selections_fingerprint' in dto) && !JSON.stringify(dto).includes('selections_fingerprint'), 'DTO NO debe incluir selections_fingerprint');
    eq(dto.items.length, 1, 'DTO expone 1 item');
    eq(Object.keys(dto.items[0]).sort().join(','), 'extras,modelName,productId,productName,quantity,unitPriceCents,variantSelections', 'el item público es EXACTAMENTE la allowlist esperada (sin images/notes/basePriceCents/modelDeltaCents internos)');
  }
}

// =======================================================================
// Grupo B: fixtures reales (services reales + dataAccess/pool en memoria)
// =======================================================================
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

function makeFakeStripe() {
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

// Pool mysql2 transaccional en memoria, igual patrón que
// scripts/check-checkout-finalization.js (recortado a lo que finalizePaidCheckout necesita).
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

// Ata los servicios REALES a fixtures en memoria, para poder inyectarlos en
// buildHandlers() y probar la cadena completa HTTP -> servicio -> pricing
// real, sin BD ni Stripe reales.
function makeRealServicesBoundToFakes() {
  const pricingDataAccess = fakePricingDataAccess();
  const draftsDataAccess = makeFakeDraftsDataAccess();
  const pool = makeFakePool(draftsDataAccess);
  const stripe = makeFakeStripe();

  const checkoutPayment = {
    async prepareCanonicalCheckout(args, options = {}) {
      return realCheckoutPayment.prepareCanonicalCheckout(args, { ...options, pricingDataAccess, draftsDataAccess });
    },
    async updateCheckoutCustomerData(args, options = {}) {
      return realCheckoutPayment.updateCheckoutCustomerData(args, { ...options, draftsDataAccess });
    }
  };
  const checkoutFinalization = {
    async finalizePaidCheckout(paymentIntent, options = {}) {
      return realCheckoutFinalization.finalizePaidCheckout(paymentIntent, { ...options, pool, draftsDataAccess });
    }
  };

  return { checkoutPayment, checkoutFinalization, stripe, pool, draftsDataAccess };
}

async function checkEndToEndViaRealServices() {
  // --- selection maliciosa (price/total/extrasTotal) -> 400 end-to-end (secciones 26/41) ---
  {
    const { checkoutPayment, checkoutFinalization, stripe } = makeRealServicesBoundToFakes();
    const handlers = buildHandlers({ checkoutPayment, checkoutFinalization, stripe, sendConfirmationEmailsFn: async () => {} });
    const res = makeRes();
    await handlers.createPaymentIntentHandler(makeReq({
      idempotencyKey: 'atk-1', accessToken: 'a'.repeat(64),
      selections: [{ productId: 8, quantity: 1, price: 0.01 }]
    }), res);
    eq(res.statusCode, 400, 'selections[].price=0.01 debe rechazarse con 400 de extremo a extremo (nunca "ignorar y cobrar")');
    ok(res.body.code === 'pricing_validation_error', 'código de error identifica el rechazo como de pricing');
  }
  for (const badField of ['basePrice', 'priceDelta', 'extrasTotal', 'total']) {
    const { checkoutPayment, checkoutFinalization, stripe } = makeRealServicesBoundToFakes();
    const handlers = buildHandlers({ checkoutPayment, checkoutFinalization, stripe, sendConfirmationEmailsFn: async () => {} });
    const res = makeRes();
    await handlers.createPaymentIntentHandler(makeReq({
      idempotencyKey: `atk-${badField}`, accessToken: 'a'.repeat(64),
      selections: [{ productId: 8, quantity: 1, [badField]: 1 }]
    }), res);
    eq(res.statusCode, 400, `selections[].${badField} debe rechazarse con 400`);
  }

  // --- flujo feliz completo: prepare -> customer-data -> confirm ---
  let happyOrderId;
  {
    const services = makeRealServicesBoundToFakes();
    const handlers = buildHandlers({ ...services, sendConfirmationEmailsFn: async () => { /* no-op: sin red real */ } });
    const accessToken = generateAccessToken();
    const selections = [{ productId: 8, quantity: 1 }];

    const prepRes = makeRes();
    await handlers.createPaymentIntentHandler(makeReq({ idempotencyKey: 'atk-happy', accessToken, selections }), prepRes);
    eq(prepRes.statusCode, 200, 'happy path: prepare -> 200');
    const { paymentIntentId } = prepRes.body;

    const patchRes = makeRes();
    await handlers.updateCustomerDataHandler(makeReq({
      accessToken,
      customerData: { name: 'Ana Muster', email: 'ana@example.com', phone: '+41791234567', address: 'Bahnhofstrasse 1', city: 'Zürich', zip: '8001', country: 'CH' }
    }), patchRes);
    eq(patchRes.statusCode, 200, 'happy path: PATCH customer-data -> 200 (país válido, CH)');
    eq(Object.keys(patchRes.body).sort().join(','), 'ok', 'PATCH customer-data responde SOLO {ok:true}, sin snapshot/customerData');

    // country con un código de la allowlist (informe de saneamiento de país)
    // -> aceptado end-to-end vía el handler HTTP real.
    const patchOtherCountryRes = makeRes();
    await handlers.updateCustomerDataHandler(makeReq({ accessToken, customerData: { name: 'A', email: 'a@b.com', phone: '1', address: '2', city: '3', zip: '4', country: 'PT' } }), patchOtherCountryRes);
    eq(patchOtherCountryRes.statusCode, 200, 'customerData.country="PT" (allowlist soportada) debe aceptarse end-to-end');

    // country fuera de la allowlist server-side -> rechazado por checkoutDrafts
    // (validateCustomerData contra config/checkout-countries.js), no basta con
    // confiar en el <select> del frontend.
    const patchInvalidCountryRes = makeRes();
    await handlers.updateCustomerDataHandler(makeReq({ accessToken, customerData: { name: 'A', email: 'a@b.com', phone: '1', address: '2', city: '3', zip: '4', country: 'US' } }), patchInvalidCountryRes);
    eq(patchInvalidCountryRes.statusCode, 400, 'customerData.country="US" (fuera de la allowlist ES/PT/FR/CH/DE/IT) debe rechazarse end-to-end');

    services.stripe._setStatus(paymentIntentId, 'succeeded');
    const confirmRes = makeRes();
    await handlers.confirmPaymentHandler(makeReq({ paymentIntentId }), confirmRes);
    eq(confirmRes.statusCode, 200, 'happy path: confirm-payment -> 200');
    eq(confirmRes.body.created, true, 'confirm-payment: created:true en la primera confirmación');
    ok(Number.isInteger(confirmRes.body.orderId), 'confirm-payment devuelve un orderId numérico');
    happyOrderId = confirmRes.body.orderId;

    // retry del mismo PI -> mismo orderId, created:false, sin segundo pedido.
    const retryRes = makeRes();
    await handlers.confirmPaymentHandler(makeReq({ paymentIntentId }), retryRes);
    eq(retryRes.statusCode, 200, 'retry confirm-payment -> 200');
    eq(retryRes.body.created, false, 'retry: created:false');
    eq(retryRes.body.orderId, happyOrderId, 'retry: MISMO orderId');
  }

  // --- idempotencyKey reutilizada con selecciones distintas -> 409 ---
  {
    const { checkoutPayment, checkoutFinalization, stripe } = makeRealServicesBoundToFakes();
    const handlers = buildHandlers({ checkoutPayment, checkoutFinalization, stripe });
    const accessToken = generateAccessToken();
    const res1 = makeRes();
    await handlers.createPaymentIntentHandler(makeReq({ idempotencyKey: 'atk-conflict', accessToken, selections: [{ productId: 8, quantity: 1 }] }), res1);
    eq(res1.statusCode, 200, 'primera creación con atk-conflict -> 200');

    const res2 = makeRes();
    await handlers.createPaymentIntentHandler(makeReq({ idempotencyKey: 'atk-conflict', accessToken, selections: [{ productId: 8, quantity: 2 }] }), res2);
    eq(res2.statusCode, 409, 'misma idempotencyKey con selections distintas -> 409');

    // mismo key + mismas selections + mismo token -> reutiliza el draft (200, reused:true)
    const res3 = makeRes();
    await handlers.createPaymentIntentHandler(makeReq({ idempotencyKey: 'atk-conflict', accessToken, selections: [{ productId: 8, quantity: 1 }] }), res3);
    eq(res3.statusCode, 200, 'mismo key+token+selections -> 200 (reutiliza)');
    eq(res3.body.reused, true, 'reused:true en el retry idéntico');
    eq(res3.body.draftId, res1.body.draftId, 'reutiliza el MISMO draftId');
  }

  // --- token incorrecto en el retry -> 403 ---
  {
    const { checkoutPayment, checkoutFinalization, stripe } = makeRealServicesBoundToFakes();
    const handlers = buildHandlers({ checkoutPayment, checkoutFinalization, stripe });
    const res1 = makeRes();
    await handlers.createPaymentIntentHandler(makeReq({ idempotencyKey: 'atk-token', accessToken: generateAccessToken(), selections: [{ productId: 8, quantity: 1 }] }), res1);
    eq(res1.statusCode, 200, 'primera creación -> 200');

    const res2 = makeRes();
    await handlers.createPaymentIntentHandler(makeReq({ idempotencyKey: 'atk-token', accessToken: generateAccessToken(), selections: [{ productId: 8, quantity: 1 }] }), res2);
    eq(res2.statusCode, 403, 'mismo key con OTRO accessToken -> 403');
  }

  // --- PI processing / requires_payment_method -> confirm-payment no crea pedido ---
  for (const status of ['processing', 'requires_payment_method']) {
    const services = makeRealServicesBoundToFakes();
    const handlers = buildHandlers({ ...services });
    const accessToken = generateAccessToken();
    const prepRes = makeRes();
    await handlers.createPaymentIntentHandler(makeReq({ idempotencyKey: `atk-${status}`, accessToken, selections: [{ productId: 8, quantity: 1 }] }), prepRes);
    const { paymentIntentId } = prepRes.body;
    services.stripe._setStatus(paymentIntentId, status);

    const confirmRes = makeRes();
    await handlers.confirmPaymentHandler(makeReq({ paymentIntentId }), confirmRes);
    eq(confirmRes.statusCode, 409, `PI en estado "${status}" -> confirm-payment responde 409, no succeeded`);
    eq(services.pool._state.pedidos.size, 0, `PI en estado "${status}" no debe haber creado ningún pedido`);
  }
}

async function main() {
  await checkRouteLayerHttpMapping();
  await checkEndToEndViaRealServices();
  console.log(`OK: ${checks} comprobaciones sobre las rutas públicas de checkout canónico (routes/payments.js).`);
}

main().catch(err => {
  console.error('FALLO en check-checkout-routes.js:', err.message, err.stack);
  process.exit(1);
});
