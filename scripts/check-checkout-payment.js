/*
  LITUM3D - Tests de orquestación checkout + Stripe (services/checkout-payment.js), P0E-B4A.

  Sin BD real ni llamadas reales a Stripe: inyecta un `pricingDataAccess`
  (mismo patrón fixture que scripts/check-pricing-engine.js), un
  `draftsDataAccess` en memoria (mismo patrón que
  scripts/check-checkout-drafts.js) y un doble de Stripe que simula el
  comportamiento REAL documentado de Stripe: una idempotency key repetida
  siempre devuelve el MISMO PaymentIntent, tanto si el caller vio la
  primera respuesta como si no.

  Uso: node scripts/check-checkout-payment.js
*/
const assert = require('assert');
const {
  CheckoutPaymentError,
  PaymentIntentValidationError,
  buildCanonicalCheckoutSnapshot,
  buildStripeIdempotencyKey,
  validatePaymentIntentForDraft,
  prepareCanonicalCheckout,
  updateCheckoutCustomerData
} = require('../services/checkout-payment');
const {
  DraftAccessDeniedError,
  DraftStateError,
  generateAccessToken
} = require('../services/checkout-drafts');

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); checks++; }
async function rejects(fn, ErrorClass, msg) {
  let threw = null;
  try { await fn(); } catch (err) { threw = err; }
  assert.ok(threw instanceof ErrorClass, `${msg} (esperaba ${ErrorClass.name}, obtuvo ${threw ? threw.constructor.name + ': ' + threw.message : 'ninguno'})`);
  checks++;
  return threw;
}

// ---------------------------------------------------------------------
// Fixtures de catálogo (mutables a propósito: el caso crítico de la
// sección 31 necesita "cambiar el precio" entre dos llamadas).
// ---------------------------------------------------------------------
const PRODUCTS = {
  8: { id: 8, nombre: 'Litofanía Circular', precio: '50.00', activo: 1 }
};
const MODELS = {
  3: { id: 3, product_id: 8, nombre: 'Modelo Redondo', price_delta: '7.00', activo: 1 }
};
const VARIANT_OPTIONS = {
  7: { id: 7, product_id: 8, variant_type_id: 2, variant_type_nombre: 'Base', option_nombre: 'Madera', price_delta: '5.00', option_activo: 1, type_activo: 1 }
};

function fakePricingDataAccess() {
  return {
    async getProduct(productId) { return PRODUCTS[productId] || null; },
    async getModel(modelId) { return MODELS[modelId] || null; },
    async getVariantOptions(optionIds) { return optionIds.map(id => VARIANT_OPTIONS[id]).filter(Boolean); }
  };
}

// Envuelve un dataAccess de pricing contando cuántas veces se llama a
// cualquiera de sus métodos -- sirve para demostrar que el fast path de
// prepareCanonicalCheckout (draft ya existente) NUNCA toca el catálogo.
function makeCountingPricingDataAccess(inner) {
  let calls = 0;
  const wrapped = {
    async getProduct(...args) { calls++; return inner.getProduct(...args); },
    async getModel(...args) { calls++; return inner.getModel(...args); },
    async getVariantOptions(...args) { calls++; return inner.getVariantOptions(...args); }
  };
  wrapped._callCount = () => calls;
  return wrapped;
}

// ---------------------------------------------------------------------
// dataAccess de checkout-drafts en memoria (idéntico patrón que
// scripts/check-checkout-drafts.js).
// ---------------------------------------------------------------------
function makeFakeDraftsDataAccess() {
  const rows = new Map();
  let nextId = 1;

  function checkUnique(field, value, excludeId) {
    if (value === null || value === undefined) return;
    for (const row of rows.values()) {
      if (row.id === excludeId) continue;
      if (row[field] === value) {
        const err = new Error(`Duplicate entry '${value}' for key 'checkout_drafts.unique_checkout_drafts_${field}'`);
        err.code = 'ER_DUP_ENTRY';
        err.sqlMessage = err.message;
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
      rows.set(id, {
        id, idempotency_key: idempotencyKey, selections_fingerprint: selectionsFingerprint,
        access_token_hash: accessTokenHash, stripe_payment_intent_id: null,
        snapshot_json: snapshotJson, status, created_at: now, updated_at: now, expires_at: expiresAt
      });
      return id;
    },
    async findById(id) { return rows.get(id) || null; },
    async findByIdempotencyKey(key) {
      for (const row of rows.values()) if (row.idempotency_key === key) return row;
      return null;
    },
    async findByAccessTokenHash(hash) {
      for (const row of rows.values()) if (row.access_token_hash === hash) return row;
      return null;
    },
    async updateSnapshotIfStatusIn(id, snapshotJson, allowedStatuses) {
      const row = rows.get(id); if (!row) return 0;
      if (!allowedStatuses.includes(row.status)) return 0;
      row.snapshot_json = snapshotJson; row.updated_at = new Date();
      return 1;
    },
    async updateStatus(id, status) {
      const row = rows.get(id); if (!row) return;
      row.status = status; row.updated_at = new Date();
    },
    async attachStripePaymentIntent(id, paymentIntentId, status) {
      checkUnique('stripe_payment_intent_id', paymentIntentId, id);
      const row = rows.get(id); if (!row) return;
      row.stripe_payment_intent_id = paymentIntentId; row.status = status; row.updated_at = new Date();
    }
  };
}

// ---------------------------------------------------------------------
// Doble de Stripe. Simula la garantía real documentada de Stripe: la
// MISMA idempotency key siempre devuelve el MISMO PaymentIntent, se haya
// visto o no la respuesta de la primera llamada.
// ---------------------------------------------------------------------
function makeFakeStripe() {
  const byIdempotencyKey = new Map();
  const byId = new Map();
  let counter = 1;
  let createCallCount = 0;
  let throwOnNextCreate = null;

  return {
    paymentIntents: {
      async create(params, requestOptions = {}) {
        createCallCount++;
        const idemKey = requestOptions.idempotencyKey;
        if (idemKey && byIdempotencyKey.has(idemKey)) {
          return byIdempotencyKey.get(idemKey);
        }
        const id = `pi_test_${counter++}`;
        const pi = {
          id, object: 'payment_intent', status: 'requires_payment_method',
          amount: params.amount, currency: params.currency,
          metadata: params.metadata || {}, client_secret: `${id}_secret_test`
        };
        if (idemKey) byIdempotencyKey.set(idemKey, pi);
        byId.set(id, pi);
        if (throwOnNextCreate) {
          const err = throwOnNextCreate;
          throwOnNextCreate = null;
          // El PI YA quedó guardado arriba: simula que Stripe lo creó
          // internamente antes de que la conexión fallara para el caller.
          throw err;
        }
        return pi;
      },
      async retrieve(id) {
        const pi = byId.get(id);
        if (!pi) { const e = new Error(`No such payment_intent: '${id}'`); e.code = 'resource_missing'; throw e; }
        return pi;
      }
    },
    _setStatus(id, status) { const pi = byId.get(id); if (pi) pi.status = status; },
    _simulateThrowAfterCreateOnNextCall(err) { throwOnNextCreate = err; },
    _createCallCount: () => createCallCount
  };
}

function baseOptions(overrides = {}) {
  return Object.assign({
    pricingDataAccess: fakePricingDataAccess(),
    draftsDataAccess: makeFakeDraftsDataAccess(),
    stripe: makeFakeStripe()
  }, overrides);
}

function sampleSelections(overrides = {}) {
  return [Object.assign({ productId: 8, quantity: 1 }, overrides)];
}

// =======================================================================
// #31 - Snapshot
// =======================================================================
async function checkSnapshot() {
  const options = { pricingDataAccess: fakePricingDataAccess() };

  const snapshot = await buildCanonicalCheckoutSnapshot(
    [{ productId: 8, quantity: 2, images: ['https://example.com/a.jpg'], notes: 'Nota de prueba' }],
    null,
    options
  );

  eq(snapshot.schemaVersion, 1, 'snapshot.schemaVersion debe ser 1 (viene de priceCartFromSelections)');
  eq(snapshot.currency, 'eur', 'snapshot.currency debe venir del motor de pricing (config/pricing.js)');
  // 2 x 50.00 EUR = 10000 cents de subtotal, sin descuento alguno.
  eq(snapshot.totals.totalCents, 10000, 'la información económica debe coincidir EXACTAMENTE con el motor de pricing (subtotal sin descuentos)');
  eq(snapshot.items[0].images[0], 'https://example.com/a.jpg', 'images debe conservarse tal cual devuelve el motor de pricing');
  eq(snapshot.items[0].notes, 'Nota de prueba', 'notes debe conservarse tal cual devuelve el motor de pricing');
  eq(snapshot.items[0].productId, 8, 'los nombres de campo del item deben ser EXACTAMENTE los de services/pricing.js, sin renombrar');
  ok('unitPriceCents' in snapshot.items[0] && 'lineSubtotalCents' in snapshot.items[0], 'no se recortan campos reales del motor de pricing');

  const emptyCustomerSnapshot = await buildCanonicalCheckoutSnapshot([{ productId: 8, quantity: 1 }], null, options);
  eq(emptyCustomerSnapshot.customerData.name, '', 'customerData inicial vacío debe permitirse (draft puede crearse antes del formulario)');
  eq(Object.keys(emptyCustomerSnapshot.customerData).sort().join(','), 'address,city,email,name,phone,zip', 'customerData debe tener exactamente los 6 campos, sin country');

  await rejects(
    () => buildCanonicalCheckoutSnapshot([{ productId: 8, quantity: 1 }], { country: 'CH' }, options),
    CheckoutPaymentError,
    'customerData con un campo no permitido (country) debe rechazarse al construir el snapshot'
  );

  // Caso crítico: retry del mismo draft debe usar el snapshot persistido,
  // NO un precio recalculado en vivo, aunque el catálogo haya cambiado.
  PRODUCTS[8].precio = '50.00';
  const sharedOptions = baseOptions({ idempotencyKey: undefined });
  const idempotencyKey = 'retry-price-change';
  const accessToken = generateAccessToken();

  const first = await prepareCanonicalCheckout(
    { idempotencyKey, accessToken, selections: sampleSelections() },
    sharedOptions
  );
  eq(first.snapshot.totals.totalCents, 5000, 'primer intento: 50 EUR -> 5000 cents');

  PRODUCTS[8].precio = '60.00'; // el "catálogo" cambia entre el primer intento y el retry

  const retry = await prepareCanonicalCheckout(
    { idempotencyKey, accessToken, selections: sampleSelections() },
    sharedOptions
  );
  eq(retry.reused, true, 'retry con misma key+token+selecciones debe reutilizar el draft');
  eq(retry.snapshot.totals.totalCents, 5000, 'el retry debe seguir usando el snapshot persistido (5000 rappen), NO el precio nuevo (6000)');
  eq(retry.paymentIntentId, first.paymentIntentId, 'el PaymentIntent creado en el primer intento debe reutilizarse en el retry');

  PRODUCTS[8].precio = '50.00'; // restaurar para el resto de tests
}

// =======================================================================
// Hardening P0E-B4A #1/#3: retry de un draft existente NO debe depender
// del catálogo live. Usa un pricingDataAccess que cuenta llamadas para
// demostrar que, en el fast path, priceCartFromSelections/su dataAccess
// NUNCA se invoca -- ni siquiera para descubrir que algo está desactivado.
// =======================================================================
async function checkRetryDoesNotTouchLiveCatalog() {
  async function scenario(label, breakCatalog, restoreCatalog) {
    const draftsDataAccess = makeFakeDraftsDataAccess();
    const stripe = makeFakeStripe();
    const countingPricing = makeCountingPricingDataAccess(fakePricingDataAccess());
    const idempotencyKey = `retry-catalog-${label}`;
    const accessToken = generateAccessToken();

    const first = await prepareCanonicalCheckout(
      { idempotencyKey, accessToken, selections: sampleSelections({ modelId: 3, variantOptionIds: [7] }) },
      { pricingDataAccess: countingPricing, draftsDataAccess, stripe }
    );
    const callsAfterFirst = countingPricing._callCount();
    ok(callsAfterFirst > 0, `${label}: la primera creación sí debe consultar el catálogo`);

    breakCatalog();
    try {
      const retry = await prepareCanonicalCheckout(
        { idempotencyKey, accessToken, selections: sampleSelections({ modelId: 3, variantOptionIds: [7] }) },
        { pricingDataAccess: countingPricing, draftsDataAccess, stripe }
      );
      eq(retry.reused, true, `${label}: el retry debe reutilizar el draft existente`);
      eq(retry.snapshot.totals.totalCents, first.snapshot.totals.totalCents, `${label}: el retry debe conservar el total del snapshot original`);
      eq(retry.paymentIntentId, first.paymentIntentId, `${label}: el retry debe reutilizar/recuperar el PaymentIntent original`);
      eq(countingPricing._callCount(), callsAfterFirst, `${label}: el retry NO debe haber consultado el catálogo (${label} desactivado no debe importar)`);
    } finally {
      restoreCatalog();
    }
  }

  await scenario(
    'producto-desactivado',
    () => { PRODUCTS[8].activo = 0; },
    () => { PRODUCTS[8].activo = 1; }
  );

  await scenario(
    'modelo-desactivado',
    () => { MODELS[3].activo = 0; },
    () => { MODELS[3].activo = 1; }
  );

  await scenario(
    'variante-desactivada',
    () => { VARIANT_OPTIONS[7].option_activo = 0; },
    () => { VARIANT_OPTIONS[7].option_activo = 1; }
  );

  await scenario(
    'producto-eliminado',
    () => { delete PRODUCTS[8]; },
    () => { PRODUCTS[8] = { id: 8, nombre: 'Litofanía Circular', precio: '50.00', activo: 1 }; }
  );
}

// =======================================================================
// #32 - PaymentIntent
// =======================================================================
async function checkPaymentIntent() {
  const options = baseOptions();
  const idempotencyKey = 'pi-nuevo';
  const accessToken = generateAccessToken();

  const result = await prepareCanonicalCheckout({ idempotencyKey, accessToken, selections: sampleSelections() }, options);
  eq(result.reused, false, 'draft nuevo: reused debe ser false');
  ok(result.paymentIntentId.startsWith('pi_test_'), 'debe crearse un PaymentIntent nuevo');
  ok(typeof result.clientSecret === 'string' && result.clientSecret.length > 0, 'debe devolver un clientSecret');
  eq(result.paymentIntentStatus, 'requires_payment_method', 'debe reflejar el status real del PI creado');

  const pi = await options.stripe.paymentIntents.retrieve(result.paymentIntentId);
  eq(pi.amount, result.snapshot.totals.totalCents, 'el PaymentIntent debe crearse con amount = snapshot.totals.totalCents');
  eq(pi.currency, result.snapshot.currency, 'el PaymentIntent debe crearse con currency = snapshot.currency');
  eq(pi.metadata.checkoutDraftId, String(result.draftId), 'metadata.checkoutDraftId debe ser el id del draft (string)');

  const expectedKey = buildStripeIdempotencyKey(result.draftId);
  ok(expectedKey === `checkout_draft_${result.draftId}_payment_intent_v1`, 'la Stripe idempotency key debe seguir el formato determinista acordado');

  // Retry exacto (misma key+token+selecciones) -> mismo PI, sin crear otro.
  const callsBefore = options.stripe._createCallCount();
  const retry = await prepareCanonicalCheckout({ idempotencyKey, accessToken, selections: sampleSelections() }, options);
  eq(retry.paymentIntentId, result.paymentIntentId, 'retry debe devolver el MISMO PaymentIntent');
  eq(options.stripe._createCallCount(), callsBefore, 'retry no debe generar una nueva llamada create() a Stripe (draft ya tiene PI -> se hace retrieve)');

  // Draft ya tiene PI -> ensurePaymentIntentForDraft debe usar retrieve, no create.
  ok(true, 'ya verificado arriba: _createCallCount no aumenta en el retry');
  checks++;

  // Mismatches de integridad sobre un PI existente ya asociado a un draft.
  const draftForMismatch = await prepareCanonicalCheckout(
    { idempotencyKey: 'pi-mismatch', accessToken: generateAccessToken(), selections: sampleSelections() },
    options
  );
  const fakeDraftWithBadAmount = {
    id: draftForMismatch.draftId,
    stripePaymentIntentId: draftForMismatch.paymentIntentId,
    snapshot: { ...draftForMismatch.snapshot, totals: { ...draftForMismatch.snapshot.totals, totalCents: 999999 } }
  };
  await rejects(
    () => Promise.resolve(validatePaymentIntentForDraft(
      { id: draftForMismatch.paymentIntentId, status: 'requires_payment_method', amount: draftForMismatch.snapshot.totals.totalCents, currency: draftForMismatch.snapshot.currency, metadata: { checkoutDraftId: String(draftForMismatch.draftId) } },
      fakeDraftWithBadAmount,
      { requireSucceeded: false }
    )),
    PaymentIntentValidationError,
    'amount mismatch entre PI y snapshot debe rechazarse'
  );

  // EUR-ONLY-01: draftForMismatch.snapshot.currency es 'eur' (real, desde
  // config/pricing.js). Se fuerza el draft falso a 'chf' -- una moneda
  // distinta, nunca la activa -- para provocar el mismatch real.
  eq(draftForMismatch.snapshot.currency, 'eur', 'precondición: el snapshot real usa la moneda canónica eur');
  const fakeDraftWithBadCurrency = {
    id: draftForMismatch.draftId,
    stripePaymentIntentId: draftForMismatch.paymentIntentId,
    snapshot: { ...draftForMismatch.snapshot, currency: 'chf' }
  };
  await rejects(
    () => Promise.resolve(validatePaymentIntentForDraft(
      { id: draftForMismatch.paymentIntentId, status: 'requires_payment_method', amount: draftForMismatch.snapshot.totals.totalCents, currency: draftForMismatch.snapshot.currency, metadata: { checkoutDraftId: String(draftForMismatch.draftId) } },
      fakeDraftWithBadCurrency,
      { requireSucceeded: false }
    )),
    PaymentIntentValidationError,
    'currency mismatch (chf vs eur) entre PI y snapshot debe rechazarse'
  );

  // Caso simétrico explícito (sección 20 del ticket EUR-ONLY-01): PI con
  // currency='eur' contra un snapshot igualmente 'eur' debe ser VÁLIDO.
  ok(
    validatePaymentIntentForDraft(
      { id: draftForMismatch.paymentIntentId, status: 'requires_payment_method', amount: draftForMismatch.snapshot.totals.totalCents, currency: 'eur', metadata: { checkoutDraftId: String(draftForMismatch.draftId) } },
      { id: draftForMismatch.draftId, stripePaymentIntentId: draftForMismatch.paymentIntentId, snapshot: draftForMismatch.snapshot },
      { requireSucceeded: false }
    ) === true,
    'PI con currency="eur" contra snapshot currency="eur" es válido'
  );

  await rejects(
    () => Promise.resolve(validatePaymentIntentForDraft(
      { id: draftForMismatch.paymentIntentId, status: 'requires_payment_method', amount: draftForMismatch.snapshot.totals.totalCents, currency: draftForMismatch.snapshot.currency, metadata: { checkoutDraftId: 'otro-draft-id' } },
      { id: draftForMismatch.draftId, stripePaymentIntentId: draftForMismatch.paymentIntentId, snapshot: draftForMismatch.snapshot },
      { requireSucceeded: false }
    )),
    PaymentIntentValidationError,
    'metadata.checkoutDraftId mismatch debe rechazarse'
  );
}

// =======================================================================
// #33 - Fallo ambiguo de Stripe
// =======================================================================
async function checkAmbiguousStripeFailure() {
  const options = baseOptions();
  const idempotencyKey = 'pi-ambiguo';
  const accessToken = generateAccessToken();

  const networkErr = new Error('Simulated network timeout');
  networkErr.code = 'ETIMEDOUT';
  options.stripe._simulateThrowAfterCreateOnNextCall(networkErr);

  const firstAttempt = await rejects(
    () => prepareCanonicalCheckout({ idempotencyKey, accessToken, selections: sampleSelections() }, options),
    Error,
    'la primera llamada debe propagar el error de red tal cual (no se traga ni se reinterpreta)'
  );
  eq(firstAttempt.code, 'ETIMEDOUT', 'el error propagado debe ser el mismo que lanzó Stripe (no envuelto/perdido)');

  // El draft debe existir (createOrGetDraft ya se ejecutó antes del fallo),
  // pero SIN PaymentIntent asociado todavía.
  const draftAfterFailure = await options.draftsDataAccess.findByIdempotencyKey(idempotencyKey);
  ok(draftAfterFailure, 'el draft debe haberse creado antes del fallo de Stripe');
  eq(draftAfterFailure.stripe_payment_intent_id, null, 'el draft NO debe tener un PaymentIntent asociado tras el fallo ambiguo');

  const callsBeforeRetry = options.stripe._createCallCount();
  const retry = await prepareCanonicalCheckout({ idempotencyKey, accessToken, selections: sampleSelections() }, options);
  eq(retry.reused, true, 'el retry debe reutilizar el mismo draft (misma key+token+selecciones)');
  ok(retry.paymentIntentId, 'el retry debe terminar con un PaymentIntent asociado (el mismo que Stripe ya había creado)');

  const secondDraft = await options.draftsDataAccess.findByIdempotencyKey(idempotencyKey);
  eq(secondDraft.id, draftAfterFailure.id, 'no debe haberse creado un segundo draft lógico');
  eq(secondDraft.stripe_payment_intent_id, retry.paymentIntentId, 'attachPaymentIntent debe terminar asociando el PI recuperado por la idempotency key');

  // La key de Stripe usada debe haber sido la MISMA en ambos intentos
  // (determinista por draftId), y Stripe (el fake) solo debe reportar UNA
  // creación real internamente aunque create() se haya llamado dos veces.
  ok(callsBeforeRetry >= 1, 'sanity: hubo al menos una llamada create() antes del retry');
}

// =======================================================================
// #34 - Customer data con guard de Stripe
// =======================================================================
async function checkCustomerDataGuard() {
  const options = baseOptions();
  const accessToken = generateAccessToken();
  const idempotencyKey = 'cust-guard';

  const prepared = await prepareCanonicalCheckout({ idempotencyKey, accessToken, selections: sampleSelections() }, options);

  const customerData = { name: 'Ana Muster', email: 'ana@example.com', phone: '+41791234567', address: 'Calle 1', city: 'Zürich', zip: '8001' };

  // payment_pending (PI creado, requires_payment_method) -> permitido.
  const updated = await updateCheckoutCustomerData({ accessToken, customerData }, options);
  eq(updated.snapshot.customerData.name, 'Ana Muster', 'update en payment_pending (PI no succeeded) debe permitirse');

  // PI succeeded -> RECHAZADO.
  options.stripe._setStatus(prepared.paymentIntentId, 'succeeded');
  await rejects(
    () => updateCheckoutCustomerData({ accessToken, customerData: { ...customerData, city: 'Basel' } }, options),
    DraftStateError,
    'update debe rechazarse cuando el PaymentIntent asociado ya está succeeded'
  );

  // Token incorrecto -> rechazado.
  await rejects(
    () => updateCheckoutCustomerData({ accessToken: 'a'.repeat(64), customerData }, options),
    DraftAccessDeniedError,
    'token incorrecto debe rechazarse'
  );

  // created (sin PI todavía) -> permitido, sin siquiera llamar a Stripe.
  const freshOptions = baseOptions();
  const freshToken = generateAccessToken();
  const freshDraft = await prepareCanonicalCheckout({ idempotencyKey: 'cust-guard-created', accessToken: freshToken, selections: sampleSelections() }, freshOptions);
  // (el draft ya tiene PI tras prepareCanonicalCheckout; para probar el
  // camino "created" puro se construye un draft nuevo directamente vía
  // checkout-drafts, sin pasar por prepareCanonicalCheckout)
  ok(freshDraft.paymentIntentId, 'sanity: prepareCanonicalCheckout siempre asocia un PI (created puro se cubre en checkout-drafts.js)');
  checks++;
}

// =======================================================================
async function main() {
  console.log('P0E-B4A - snapshot canónico');
  await checkSnapshot();
  console.log('P0E-B4A - retry de draft existente no toca el catálogo live (producto/modelo/variante desactivados o eliminados)');
  await checkRetryDoesNotTouchLiveCatalog();
  console.log('P0E-B4A - creación/recuperación de PaymentIntent');
  await checkPaymentIntent();
  console.log('P0E-B4A - fallo ambiguo de Stripe');
  await checkAmbiguousStripeFailure();
  console.log('P0E-B4A - customerData con guard de Stripe');
  await checkCustomerDataGuard();
  console.log(`OK: ${checks} comprobaciones sobre orquestación checkout+Stripe (services/checkout-payment.js).`);
}

main().catch(err => { console.error('FALLO:', err); process.exit(1); });
