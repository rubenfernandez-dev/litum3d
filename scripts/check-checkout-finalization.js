/*
  LITUM3D - Tests de finalización de checkout pagado (services/checkout-finalization.js), P0E-B4A.

  Sin BD real: simula un pool mysql2 transaccional en memoria (getConnection
  con beginTransaction/commit/rollback reales sobre un snapshot del estado,
  y detección de violación UNIQUE en pedidos.stripe_payment_intent_id igual
  que el driver real: err.code='ER_DUP_ENTRY' + err.sqlMessage con el
  nombre de la constraint). El objetivo es validar la lógica de
  orquestación/transacción/idempotencia, no el motor de MySQL en sí (para
  eso existe el test de integración opcional
  scripts/check-checkout-finalization-mysql.js, con Docker, fuera de
  npm test).

  Uso: node scripts/check-checkout-finalization.js
*/
const assert = require('assert');
const {
  CentsRangeError,
  FinalizationIntegrityError,
  CHECKOUT_COUNTRY_CODE,
  assertFitsDecimal10_2,
  centsToDecimalString,
  finalizePaidCheckout
} = require('../services/checkout-finalization');
const { PaymentIntentValidationError } = require('../services/checkout-payment');
const { DraftNotFoundError } = require('../services/checkout-drafts');

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

// =======================================================================
// #38 - centsToDecimalString / assertFitsDecimal10_2
// =======================================================================
function checkDecimalConversion() {
  const cases = [[0, '0.00'], [5, '0.05'], [95, '0.95'], [100, '1.00'], [7095, '70.95'], [-500, '-5.00']];
  for (const [cents, expected] of cases) {
    eq(centsToDecimalString(cents), expected, `centsToDecimalString(${cents}) debe ser "${expected}"`);
  }

  eq(centsToDecimalString(9999999999), '99999999.99', 'el límite exacto de DECIMAL(10,2) debe convertirse correctamente');
  eq(assertFitsDecimal10_2(9999999999, 'x'), 9999999999, 'el límite exacto debe aceptarse');
  assert.throws(() => assertFitsDecimal10_2(10000000000, 'x'), CentsRangeError, 'por encima del límite de DECIMAL(10,2) debe rechazarse'); checks++;
  assert.throws(() => assertFitsDecimal10_2(-1, 'x'), CentsRangeError, 'negativo debe rechazarse'); checks++;
  assert.throws(() => assertFitsDecimal10_2(NaN, 'x'), CentsRangeError, 'NaN debe rechazarse'); checks++;
  assert.throws(() => assertFitsDecimal10_2(Infinity, 'x'), CentsRangeError, 'Infinity debe rechazarse'); checks++;
  assert.throws(() => assertFitsDecimal10_2(5.5, 'x'), CentsRangeError, 'float no entero debe rechazarse'); checks++;
  assert.throws(() => assertFitsDecimal10_2(Number.MAX_SAFE_INTEGER + 10, 'x'), CentsRangeError, 'unsafe integer debe rechazarse'); checks++;
  assert.throws(() => centsToDecimalString(NaN), CentsRangeError, 'centsToDecimalString(NaN) debe rechazarse'); checks++;
  assert.throws(() => centsToDecimalString(5.5), CentsRangeError, 'centsToDecimalString(float) debe rechazarse'); checks++;
}

// ---------------------------------------------------------------------
// Pool mysql2 transaccional en memoria.
// ---------------------------------------------------------------------
function makeFakePool() {
  const state = {
    checkoutDrafts: new Map(),
    pedidos: new Map(),
    detallePedidos: new Map(),
    detalleImagenes: new Map(),
    nextPedidoId: 1,
    nextDetalleId: 1,
    nextImagenId: 1
  };
  let forceFail = null; // { matcher: sql => bool, err }

  function cloneMap(m) { return new Map([...m].map(([k, v]) => [k, { ...v }])); }
  function snapshotState() {
    return {
      checkoutDrafts: cloneMap(state.checkoutDrafts),
      pedidos: cloneMap(state.pedidos),
      detallePedidos: cloneMap(state.detallePedidos),
      detalleImagenes: cloneMap(state.detalleImagenes),
      nextPedidoId: state.nextPedidoId, nextDetalleId: state.nextDetalleId, nextImagenId: state.nextImagenId
    };
  }
  function restoreState(snap) {
    state.checkoutDrafts = snap.checkoutDrafts;
    state.pedidos = snap.pedidos;
    state.detallePedidos = snap.detallePedidos;
    state.detalleImagenes = snap.detalleImagenes;
    state.nextPedidoId = snap.nextPedidoId;
    state.nextDetalleId = snap.nextDetalleId;
    state.nextImagenId = snap.nextImagenId;
  }
  function checkPedidoUnique(paymentIntentId) {
    if (!paymentIntentId) return;
    for (const row of state.pedidos.values()) {
      if (row.stripe_payment_intent_id === paymentIntentId) {
        const err = new Error(`Duplicate entry '${paymentIntentId}' for key 'pedidos.unique_pedidos_stripe_payment_intent_id'`);
        err.code = 'ER_DUP_ENTRY'; err.sqlMessage = err.message;
        throw err;
      }
    }
  }

  async function runQuery(sql, params = []) {
    if (forceFail && forceFail.matcher(sql)) {
      const err = forceFail.err;
      forceFail = null;
      throw err;
    }
    if (sql.includes('FROM checkout_drafts WHERE id = ? FOR UPDATE')) {
      const row = state.checkoutDrafts.get(params[0]);
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
      const [pedido_id, producto_id, modelo_id, cantidad, precio_unitario, personalizacion_notas, variantes_seleccionadas] = params;
      const id = state.nextDetalleId++;
      state.detallePedidos.set(id, { id, pedido_id, producto_id, modelo_id, cantidad, precio_unitario, personalizacion_notas, variantes_seleccionadas });
      return [{ insertId: id }];
    }
    if (sql.startsWith('INSERT INTO detalle_pedido_imagenes')) {
      const [detalle_pedido_id, ruta] = params;
      const id = state.nextImagenId++;
      state.detalleImagenes.set(id, { id, detalle_pedido_id, ruta });
      return [{ insertId: id }];
    }
    if (sql.startsWith('UPDATE checkout_drafts SET status')) {
      const [status, id] = params;
      const row = state.checkoutDrafts.get(id);
      if (row) row.status = status;
      return [{ affectedRows: row ? 1 : 0 }];
    }
    throw new Error(`Fake pool: consulta no reconocida: ${sql}`);
  }

  return {
    async query(sql, params) { return runQuery(sql, params); }, // pool.query (fuera de transacción)
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
    _state: state,
    _forceFailNext(matcher, err) { forceFail = { matcher, err }; },
    _seedDraft(row) { state.checkoutDrafts.set(row.id, row); },
    _seedPedido(row) { state.pedidos.set(row.id, row); if (row.id >= state.nextPedidoId) state.nextPedidoId = row.id + 1; }
  };
}

function makeDraftsDataAccessView(fakePool) {
  return { async findById(id) { const row = fakePool._state.checkoutDrafts.get(id); return row ? { ...row } : null; } };
}

// ---------------------------------------------------------------------
// Fixtures de snapshot/draft/PaymentIntent.
// ---------------------------------------------------------------------
function buildSnapshot(overrides = {}) {
  return Object.assign({
    schemaVersion: 1,
    currency: 'eur',
    customerData: { name: 'Ana Muster', email: 'ana@example.com', phone: '+41791234567', address: 'Bahnhofstrasse 1', city: 'Zürich', zip: '8001' },
    items: [{
      productId: 8, productName: 'Litofanía Circular',
      basePriceCents: 5000, modelId: 3, modelName: 'Modelo Redondo', modelDeltaCents: 500,
      variantSelections: [{ variantTypeId: 2, variantTypeName: 'Base', optionId: 7, optionName: 'Madera', priceDeltaCents: 500 }],
      extras: { upscale: true, qr: false, adapter: false, qrMessage: '' },
      extrasPricingCents: { upscale: 500, qr: 500, adapter: 400 }, extrasTotalCents: 500,
      unitPriceCents: 6500, quantity: 1, lineSubtotalCents: 6500,
      images: [{ url: 'https://example.com/foto.jpg' }], notes: 'Grabar "Feliz cumpleaños"'
    }],
    totals: { subtotalCents: 6500, shippingCents: 0, totalCents: 6500, netCents: 5372, taxCents: 1128 }
  }, overrides);
}

let draftIdCounter = 1000;
function seedValidDraft(fakePool, { status = 'payment_pending', paymentIntentId, snapshot = buildSnapshot() } = {}) {
  const id = draftIdCounter++;
  fakePool._seedDraft({
    id, status, snapshot_json: JSON.stringify(snapshot), stripe_payment_intent_id: paymentIntentId || null,
    idempotency_key: `dk-${id}`, selections_fingerprint: 'fp', access_token_hash: 'ah',
    created_at: new Date(), updated_at: new Date(), expires_at: null
  });
  return { id, status, snapshot };
}

function buildPaymentIntent({ id, draftId, amount, currency = 'eur', status = 'succeeded' }) {
  return { id, status, amount, currency, metadata: { checkoutDraftId: String(draftId) } };
}

// =======================================================================
// #35 - Finalización
// =======================================================================
async function checkFinalizationHappyPathAndValidation() {
  const pool = makeFakePool();

  // PI not succeeded -> no pedido.
  const draftNotSucceeded = seedValidDraft(pool, { paymentIntentId: 'pi_ns' });
  const piNotSucceeded = buildPaymentIntent({ id: 'pi_ns', draftId: draftNotSucceeded.id, amount: draftNotSucceeded.snapshot.totals.totalCents, status: 'requires_action' });
  await rejects(() => finalizePaidCheckout(piNotSucceeded, { pool, draftsDataAccess: makeDraftsDataAccessView(pool) }), PaymentIntentValidationError, 'PI no succeeded no debe crear pedido');
  eq(pool._state.pedidos.size, 0, 'no debe haberse creado ningún pedido');

  // amount incorrecto.
  const draftAmount = seedValidDraft(pool, { paymentIntentId: 'pi_amt' });
  const piAmount = buildPaymentIntent({ id: 'pi_amt', draftId: draftAmount.id, amount: 1, status: 'succeeded' });
  await rejects(() => finalizePaidCheckout(piAmount, { pool, draftsDataAccess: makeDraftsDataAccessView(pool) }), PaymentIntentValidationError, 'amount incorrecto no debe crear pedido');

  // currency incorrecta (EUR-ONLY-01: la moneda canónica activa es eur, se
  // fuerza el PI a una moneda distinta -- chf -- para provocar el mismatch).
  const draftCurrency = seedValidDraft(pool, { paymentIntentId: 'pi_cur' });
  const piCurrency = buildPaymentIntent({ id: 'pi_cur', draftId: draftCurrency.id, amount: draftCurrency.snapshot.totals.totalCents, currency: 'chf', status: 'succeeded' });
  await rejects(() => finalizePaidCheckout(piCurrency, { pool, draftsDataAccess: makeDraftsDataAccessView(pool) }), PaymentIntentValidationError, 'currency incorrecta (chf) no debe crear pedido');

  // metadata ausente/incorrecta.
  const piNoMeta = { id: 'pi_no_meta', status: 'succeeded', amount: 100, currency: 'eur', metadata: {} };
  await rejects(() => finalizePaidCheckout(piNoMeta, { pool, draftsDataAccess: makeDraftsDataAccessView(pool) }), PaymentIntentValidationError, 'metadata.checkoutDraftId ausente no debe crear pedido');

  // draft no encontrado.
  const piGhostDraft = buildPaymentIntent({ id: 'pi_ghost', draftId: 999999, amount: 100, status: 'succeeded' });
  await rejects(() => finalizePaidCheckout(piGhostDraft, { pool, draftsDataAccess: makeDraftsDataAccessView(pool) }), DraftNotFoundError, 'draft inexistente debe rechazarse');

  // EUR-ONLY-01: draft "obsoleto" internamente consistente (PI y snapshot
  // coinciden entre sí en 'chf'), pero 'chf' ya no es la moneda canónica
  // activa (config/pricing.js dice 'eur'). Debe rechazarse igualmente, con
  // un error de integridad explícito, no un mismatch silencioso.
  const staleSnapshot = buildSnapshot({ currency: 'chf' });
  const draftStaleCurrency = seedValidDraft(pool, { paymentIntentId: 'pi_stale_cur', snapshot: staleSnapshot });
  const piStaleCurrency = buildPaymentIntent({ id: 'pi_stale_cur', draftId: draftStaleCurrency.id, amount: staleSnapshot.totals.totalCents, currency: 'chf', status: 'succeeded' });
  await rejects(
    () => finalizePaidCheckout(piStaleCurrency, { pool, draftsDataAccess: makeDraftsDataAccessView(pool) }),
    FinalizationIntegrityError,
    'un draft internamente consistente pero en una moneda ya no canónica (chf) debe rechazarse'
  );
  eq(pool._state.pedidos.size, 0, 'el draft con moneda obsoleta no debe haber creado ningún pedido');

  eq(pool._state.pedidos.size, 0, 'ninguno de los casos anteriores debe haber creado un pedido');

  // succeeded correcto -> crea pedido, con todo lo que pide la sección 35.
  const draft = seedValidDraft(pool, { paymentIntentId: 'pi_ok' });
  const emailCalls = [];
  const pi = buildPaymentIntent({ id: 'pi_ok', draftId: draft.id, amount: draft.snapshot.totals.totalCents, status: 'succeeded' });

  const result = await finalizePaidCheckout(pi, {
    pool,
    draftsDataAccess: makeDraftsDataAccessView(pool),
    sendConfirmationEmail: async (payload) => {
      // Verifica que el email se dispara DESPUÉS del commit: el pedido y el
      // draft ya deben ser visibles en el estado compartido en este punto.
      emailCalls.push(payload);
      ok(pool._state.pedidos.has(payload.orderId), 'email: el pedido ya debe existir en BD cuando se envía el email (post-commit)');
      eq(pool._state.checkoutDrafts.get(draft.id).status, 'converted', 'email: el draft ya debe estar converted cuando se envía el email (post-commit)');
    }
  });

  eq(result.created, true, 'debe crear el pedido');
  ok(Number.isInteger(result.orderId), 'debe devolver un orderId numérico');
  eq(result.draftId, draft.id, 'debe devolver el draftId correcto');

  const orderRow = pool._state.pedidos.get(result.orderId);
  eq(orderRow.total, centsToDecimalStringLocal(draft.snapshot.totals.totalCents), 'pedidos.total debe venir del snapshot, no de ningún input externo');
  eq(orderRow.customer_name, 'Ana Muster', 'customer_name debe venir de snapshot.customerData');
  eq(orderRow.customer_country, CHECKOUT_COUNTRY_CODE, 'customer_country debe ser el valor controlado por servidor (CH), no del cliente');
  eq(orderRow.stripe_payment_intent_id, 'pi_ok', 'stripe_payment_intent_id debe guardarse en pedidos');
  eq(orderRow.estado_id, 1, 'estado_id debe seguir siendo 1 (comportamiento actual sin cambios en B4A)');
  eq(orderRow.currency, 'EUR', 'pedidos.currency debe persistirse en mayúsculas ISO desde snapshot.currency (EUR-ONLY-01)');

  const detalle = [...pool._state.detallePedidos.values()].find(d => d.pedido_id === result.orderId);
  ok(detalle, 'debe existir el detalle del pedido');
  eq(detalle.producto_id, 8, 'detalle_pedidos.producto_id debe venir de snapshot.items[0].productId');
  eq(detalle.modelo_id, 3, 'detalle_pedidos.modelo_id debe venir de snapshot.items[0].modelId');
  eq(detalle.precio_unitario, centsToDecimalStringLocal(6500), 'detalle_pedidos.precio_unitario debe venir de snapshot.items[0].unitPriceCents');
  eq(detalle.personalizacion_notas, 'Grabar "Feliz cumpleaños"', 'personalizacion_notas debe venir de snapshot.items[0].notes');
  const variantes = JSON.parse(detalle.variantes_seleccionadas);
  eq(variantes.schemaVersion, 1, 'variantes_seleccionadas debe usar el formato canónico versionado');
  eq(variantes.variantSelections[0].optionId, 7, 'variantes_seleccionadas debe contener variantSelections del snapshot');

  const imagen = [...pool._state.detalleImagenes.values()].find(i => i.detalle_pedido_id === detalle.id);
  ok(imagen, 'debe existir la imagen del detalle');
  eq(imagen.ruta, 'https://example.com/foto.jpg', 'la imagen debe venir de snapshot.items[0].images[0].url');

  eq(pool._state.checkoutDrafts.get(draft.id).status, 'converted', 'el draft debe quedar converted');

  eq(emailCalls.length, 1, 'el email debe enviarse exactamente una vez');
  eq(emailCalls[0].orderId, result.orderId, 'el email debe referenciar el pedido correcto');

  // Retry -> mismo pedido, created:false, sin segundo email.
  const retryResult = await finalizePaidCheckout(pi, { pool, draftsDataAccess: makeDraftsDataAccessView(pool), sendConfirmationEmail: async () => emailCalls.push('retry') });
  eq(retryResult.created, false, 'retry debe devolver created:false');
  eq(retryResult.orderId, result.orderId, 'retry debe devolver el MISMO orderId');
  eq(pool._state.pedidos.size, 1, 'retry no debe crear un segundo pedido');
  eq(emailCalls.length, 1, 'retry NO debe enviar un segundo email');
}

function centsToDecimalStringLocal(cents) { return centsToDecimalString(cents); }

// =======================================================================
// #24/DECIMAL overflow en finalización real
// =======================================================================
async function checkDecimalOverflowBlocksFinalization() {
  const pool = makeFakePool();
  const hugeSnapshot = buildSnapshot({ totals: { subtotalCents: 20000000000, shippingCents: 0, totalCents: 20000000000, netCents: 16528925620, taxCents: 3471074380 } });
  const draft = seedValidDraft(pool, { paymentIntentId: 'pi_huge', snapshot: hugeSnapshot });
  const pi = buildPaymentIntent({ id: 'pi_huge', draftId: draft.id, amount: 20000000000, status: 'succeeded' });
  await rejects(() => finalizePaidCheckout(pi, { pool, draftsDataAccess: makeDraftsDataAccessView(pool) }), CentsRangeError, 'un total que excede DECIMAL(10,2) debe bloquear la finalización, no truncarse en silencio');
  eq(pool._state.pedidos.size, 0, 'no debe haberse creado ningún pedido con un total fuera de rango');
}

// =======================================================================
// #36 - Rollback
// =======================================================================
async function checkRollback() {
  // A. INSERT pedidos OK, falla INSERT detalle_pedidos -> todo rollback.
  {
    const pool = makeFakePool();
    const draft = seedValidDraft(pool, { paymentIntentId: 'pi_fail_detalle' });
    const pi = buildPaymentIntent({ id: 'pi_fail_detalle', draftId: draft.id, amount: draft.snapshot.totals.totalCents, status: 'succeeded' });
    const dbErr = new Error('Simulated DB error on detalle_pedidos insert');
    pool._forceFailNext(sql => sql.startsWith('INSERT INTO detalle_pedidos'), dbErr);

    await rejects(() => finalizePaidCheckout(pi, { pool, draftsDataAccess: makeDraftsDataAccessView(pool) }), Error, 'fallo en INSERT detalle_pedidos debe propagarse');
    eq(pool._state.pedidos.size, 0, 'A: pedidos debe quedar vacío tras el rollback');
    eq(pool._state.detallePedidos.size, 0, 'A: detalle_pedidos debe quedar vacío tras el rollback');
    eq(pool._state.detalleImagenes.size, 0, 'A: detalle_pedido_imagenes debe quedar vacío tras el rollback');
    eq(pool._state.checkoutDrafts.get(draft.id).status, 'payment_pending', 'A: el draft NO debe quedar converted tras el rollback');
  }

  // B. falla INSERT de imagen -> todo rollback también.
  {
    const pool = makeFakePool();
    const draft = seedValidDraft(pool, { paymentIntentId: 'pi_fail_imagen' });
    const pi = buildPaymentIntent({ id: 'pi_fail_imagen', draftId: draft.id, amount: draft.snapshot.totals.totalCents, status: 'succeeded' });
    const dbErr = new Error('Simulated DB error on detalle_pedido_imagenes insert');
    pool._forceFailNext(sql => sql.startsWith('INSERT INTO detalle_pedido_imagenes'), dbErr);

    await rejects(() => finalizePaidCheckout(pi, { pool, draftsDataAccess: makeDraftsDataAccessView(pool) }), Error, 'fallo en INSERT de imagen debe propagarse');
    eq(pool._state.pedidos.size, 0, 'B: pedidos debe quedar vacío tras el rollback');
    eq(pool._state.detallePedidos.size, 0, 'B: detalle_pedidos debe quedar vacío tras el rollback');
    eq(pool._state.checkoutDrafts.get(draft.id).status, 'payment_pending', 'B: el draft NO debe quedar converted tras el rollback');
  }

  // C (relacionado con #27): imagen con ruta > 255 caracteres bloquea la
  // finalización con un error propio (no un crash de MySQL) y también
  // provoca rollback completo.
  {
    const pool = makeFakePool();
    const longUrl = 'https://example.com/' + 'a'.repeat(250) + '.jpg';
    const snapshot = buildSnapshot({ items: [Object.assign({}, buildSnapshot().items[0], { images: [{ url: longUrl }] })] });
    const draft = seedValidDraft(pool, { paymentIntentId: 'pi_long_url', snapshot });
    const pi = buildPaymentIntent({ id: 'pi_long_url', draftId: draft.id, amount: draft.snapshot.totals.totalCents, status: 'succeeded' });
    await rejects(() => finalizePaidCheckout(pi, { pool, draftsDataAccess: makeDraftsDataAccessView(pool) }), FinalizationIntegrityError, 'una ruta de imagen > 255 caracteres debe rechazarse antes del INSERT');
    eq(pool._state.pedidos.size, 0, 'C: pedidos debe quedar vacío tras el rechazo por ruta demasiado larga');
  }
}

// =======================================================================
// #37 - Concurrencia / UNIQUE
// =======================================================================
async function checkConcurrencyUnique() {
  const pool = makeFakePool();

  // Simula que otra transacción YA COMMITEÓ un pedido con este PI justo
  // antes de que esta finalización intente su propio INSERT (la ventana de
  // carrera real que el lock del draft por sí solo no puede cubrir si son
  // dos drafts distintos apuntando -por error en otra capa- al mismo PI).
  pool._seedPedido({ id: 500, usuario_id: null, estado_id: 1, total: '65.00', customer_name: 'Ganador', customer_email: 'x@x.com', customer_phone: null, customer_address: null, customer_city: null, customer_zip: null, customer_country: 'CH', notas: 'Draft ganador', stripe_payment_intent_id: 'pi_race' });

  const draft = seedValidDraft(pool, { paymentIntentId: 'pi_race' });
  const pi = buildPaymentIntent({ id: 'pi_race', draftId: draft.id, amount: draft.snapshot.totals.totalCents, status: 'succeeded' });

  const emailCalls = [];
  const result = await finalizePaidCheckout(pi, { pool, draftsDataAccess: makeDraftsDataAccessView(pool), sendConfirmationEmail: async () => emailCalls.push(1) });

  eq(result.created, false, 'la finalización que pierde la carrera UNIQUE debe devolver created:false');
  eq(result.orderId, 500, 'debe recuperar el pedido ya existente (el del "ganador" de la carrera)');
  eq(pool._state.pedidos.size, 1, 'no debe haberse creado un segundo pedido');
  eq(emailCalls.length, 0, 'la finalización que pierde la carrera NO debe enviar email');
}

// =======================================================================
// Hardening P0E-B4A #7: la validación previa a abrir la transacción es
// solo un fast-fail; la que realmente autoriza el INSERT debe ser la
// revalidación contra el draft BAJO LOCK. Se simula que, entre la lectura
// previa a la transacción y el lock, el PaymentIntent asociado al draft
// cambia -- si el código siguiera confiando en la lectura previa (stale),
// esto NO se detectaría y se crearía un pedido inconsistente.
// =======================================================================
async function checkRevalidatesAgainstLockedDraft() {
  const pool = makeFakePool();
  const draft = seedValidDraft(pool, { paymentIntentId: 'pi_stale' });
  const pi = buildPaymentIntent({ id: 'pi_stale', draftId: draft.id, amount: draft.snapshot.totals.totalCents, status: 'succeeded' });

  let preTransactionReads = 0;
  const draftsView = {
    async findById(id) {
      preTransactionReads++;
      const row = pool._state.checkoutDrafts.get(id);
      if (!row) return null;
      const snapshotOfRow = { ...row };
      if (preTransactionReads === 1) {
        // Tras devolver esta lectura previa a la transacción (que sí
        // coincide con el PI), simulamos que el PI asociado al draft
        // cambia antes de que finalizePaidCheckout llegue a tomar el lock.
        row.stripe_payment_intent_id = 'pi_changed_before_lock';
      }
      return snapshotOfRow;
    }
  };

  await rejects(
    () => finalizePaidCheckout(pi, { pool, draftsDataAccess: draftsView }),
    PaymentIntentValidationError,
    'la revalidación contra el draft bloqueado debe detectar que el PI ya no coincide, aunque la lectura previa a la transacción sí coincidiera'
  );
  eq(pool._state.pedidos.size, 0, 'no debe haberse creado ningún pedido cuando la revalidación bajo lock falla');
  eq(pool._state.checkoutDrafts.get(draft.id).status, 'payment_pending', 'el draft no debe quedar converted si la revalidación bajo lock falla');
}

// =======================================================================
// Hardening P0E-B4A #8: draft converted SIN ningún pedido asociado a ese
// PaymentIntent es corrupción/inconsistencia real -- nunca debe reportarse
// como éxito idempotente con un orderId vacío.
// =======================================================================
async function checkConvertedWithoutOrderIsIntegrityError() {
  const pool = makeFakePool();
  // converted + pedido existente -> éxito idempotente (caso ya cubierto en
  // checkFinalizationHappyPathAndValidation vía el retry, se repite aquí
  // explícitamente para dejar ambos casos uno junto al otro).
  const draftWithOrder = seedValidDraft(pool, { status: 'converted', paymentIntentId: 'pi_converted_ok' });
  pool._seedPedido({ id: 700, usuario_id: null, estado_id: 1, total: '65.00', customer_name: null, customer_email: null, customer_phone: null, customer_address: null, customer_city: null, customer_zip: null, customer_country: 'CH', notas: null, stripe_payment_intent_id: 'pi_converted_ok' });
  const piOk = buildPaymentIntent({ id: 'pi_converted_ok', draftId: draftWithOrder.id, amount: draftWithOrder.snapshot.totals.totalCents, status: 'succeeded' });
  const resultOk = await finalizePaidCheckout(piOk, { pool, draftsDataAccess: makeDraftsDataAccessView(pool) });
  eq(resultOk.created, false, 'converted + pedido existente debe ser éxito idempotente');
  eq(resultOk.orderId, 700, 'debe devolver el orderId del pedido ya existente');

  // converted + pedido NO existente -> error de integridad explícito.
  const draftWithoutOrder = seedValidDraft(pool, { status: 'converted', paymentIntentId: 'pi_converted_orphan' });
  const piOrphan = buildPaymentIntent({ id: 'pi_converted_orphan', draftId: draftWithoutOrder.id, amount: draftWithoutOrder.snapshot.totals.totalCents, status: 'succeeded' });
  await rejects(
    () => finalizePaidCheckout(piOrphan, { pool, draftsDataAccess: makeDraftsDataAccessView(pool) }),
    FinalizationIntegrityError,
    'converted sin pedido asociado debe lanzar FinalizationIntegrityError, nunca created:false silencioso'
  );
}

// =======================================================================
async function main() {
  console.log('P0E-B4A - conversión rappen -> DECIMAL(10,2)');
  checkDecimalConversion();
  console.log('P0E-B4A - finalización: validación y camino feliz');
  await checkFinalizationHappyPathAndValidation();
  console.log('P0E-B4A - finalización: overflow DECIMAL bloquea la creación');
  await checkDecimalOverflowBlocksFinalization();
  console.log('P0E-B4A - finalización: rollback');
  await checkRollback();
  console.log('P0E-B4A - finalización: concurrencia / UNIQUE');
  await checkConcurrencyUnique();
  console.log('P0E-B4A - finalización: revalidación contra el draft bloqueado (lock)');
  await checkRevalidatesAgainstLockedDraft();
  console.log('P0E-B4A - finalización: converted sin pedido asociado es error de integridad');
  await checkConvertedWithoutOrderIsIntegrityError();
  console.log(`OK: ${checks} comprobaciones sobre finalización de checkout (services/checkout-finalization.js).`);
}

main().catch(err => { console.error('FALLO:', err); process.exit(1); });
