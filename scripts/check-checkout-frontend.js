/*
  LITUM3D - Tests de public/js/checkout.js (P0E-B4B, secciones 36-39).

  Carga cart.js + checkout.js TAL CUAL se sirven al navegador en un sandbox
  de Node (vm nativo), con DOM/fetch/sessionStorage/crypto mínimos
  simulados -- mismo patrón que scripts/check-frontend-selections.js. Prueba
  el CÓDIGO REAL (funciones declaradas top-level en checkout.js quedan
  expuestas como propiedades del sandbox), no una reimplementación de la
  lógica en el propio test.

  Uso: node scripts/check-checkout-frontend.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');

function readScript(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

function makeSessionStorageStub(initialStore) {
  const store = initialStore || new Map();
  return {
    _store: store,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
}

function makeLocalStorageStub() {
  const store = new Map();
  return { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
}

function makeElementStub() {
  return { textContent: '', innerHTML: '', value: '', style: {}, disabled: false, classList: { add() {}, remove() {} }, addEventListener() {} };
}

function makeFormStub(values = {}) {
  const fields = ['customer_name', 'customer_email', 'customer_phone', 'customer_address', 'customer_city', 'customer_zip'];
  const form = { checkValidity: () => true, reportValidity: () => {}, addEventListener() {} };
  for (const f of fields) form[f] = { value: values[f] || 'x' };
  const submitBtn = makeElementStub();
  form.querySelector = (sel) => (sel.includes('submit') ? submitBtn : null);
  form._submitBtn = submitBtn;
  return form;
}

function makeDocumentStub({ form } = {}) {
  const registry = new Map();
  const doc = {
    getElementById(id) {
      if (id === 'checkout-form' && form) return form;
      if (!registry.has(id)) registry.set(id, makeElementStub());
      return registry.get(id);
    },
    querySelector(sel) {
      if (form && sel.includes('#checkout-form')) return form._submitBtn;
      return null;
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => makeElementStub(),
    documentElement: { lang: 'es' },
    _registry: registry
  };
  return doc;
}

function loadCheckoutSandbox({ sessionStore, form } = {}) {
  const sandbox = {
    console,
    document: makeDocumentStub({ form }),
    window: { location: { origin: 'https://litum3d.example', href: '' }, addEventListener() {} },
    localStorage: makeLocalStorageStub(),
    sessionStorage: makeSessionStorageStub(sessionStore),
    crypto: nodeCrypto.webcrypto, // CSPRNG real de Node, mismo contrato que window.crypto
    fetch: async () => ({ ok: false, json: async () => ({ ok: false }) }),
    setTimeout: (fn) => fn(), // ejecuta inmediatamente: los tests no esperan temporizadores reales
    Stripe: () => ({})
  };
  vm.createContext(sandbox);
  vm.runInContext(readScript('public/js/cart.js'), sandbox, { filename: 'cart.js' });
  vm.runInContext(readScript('public/js/checkout.js'), sandbox, { filename: 'checkout.js' });
  return sandbox;
}

function runIn(sandbox, code) {
  return vm.runInContext(code, sandbox, { filename: 'checkout.harness.js' });
}

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); checks++; }

// =======================================================================
// Sección 36 - Serializador canónico
// =======================================================================
function checkCanonicalSerializer() {
  const sandbox = loadCheckoutSandbox();

  const legacyPriceCartItem = {
    id: 8, selectionSchemaVersion: 1, modelId: 3, modelName: 'Redondo',
    basePrice: 49.95, priceDelta: 7, price: 56.95, // legacy, NUNCA deben viajar
    extras: { upscale: true, qr: false, adapter: false, qrMessage: '', extrasTotal: 5, currency: 'CHF' }, // extrasTotal/currency legacy
    variantOptionIds: [7, 3],
    quantity: 2, images: ['a.jpg'], notes: 'hola'
  };

  const { selections, ambiguousItems } = sandbox.buildCanonicalSelectionsFromCart([legacyPriceCartItem]);
  eq(ambiguousItems.length, 0, 'un item con selectionSchemaVersion:1 y solo campos legacy de PRECIO (no de variante) no es ambiguo, es reconstruible');
  eq(selections.length, 1, 'produce 1 selección canónica');
  const sel = selections[0];
  eq(Object.keys(sel).sort().join(','), 'extras,images,modelId,notes,productId,quantity,variantOptionIds', 'la selección canónica tiene EXACTAMENTE estas claves');
  eq(sel.productId, 8, 'productId correcto');
  eq(sel.quantity, 2, 'quantity correcto');
  eq(sel.modelId, 3, 'modelId correcto');
  eq(JSON.stringify(sel.variantOptionIds), JSON.stringify([3, 7]), 'variantOptionIds normalizado y ordenado');
  eq(JSON.stringify(sel.extras), JSON.stringify({ upscale: true, qr: false, adapter: false, qrMessage: '' }), 'extras es SOLO {upscale,qr,adapter,qrMessage}');
  ok(!('extrasTotal' in sel.extras) && !('currency' in sel.extras), 'extras NUNCA contiene extrasTotal/currency legacy');

  const serialized = JSON.stringify(selections);
  for (const forbidden of ['"price"', '"basePrice"', '"priceDelta"', '"extrasTotal"', '"currency"', '"subtotal"', '"total"', '"discount"', '"tax"', '"selectionSchemaVersion"']) {
    ok(!serialized.includes(forbidden), `el payload canónico NUNCA debe contener la clave ${forbidden}`);
  }

  // Item ambiguo: baseId/shapeId (formato legacy pre-variantOptionIds), y por
  // supuesto sin selectionSchemaVersion (nunca lo tuvo).
  const legacyVariantItem = { id: 9, quantity: 1, baseId: 3, shapeId: 5, price: 10 };
  const res2 = sandbox.buildCanonicalSelectionsFromCart([legacyVariantItem]);
  eq(res2.selections.length, 0, 'item con baseId/shapeId NO se serializa');
  eq(res2.ambiguousItems.length, 1, 'item con baseId/shapeId se marca como ambiguo');

  // Item con id envuelto (shape legacy más antiguo).
  const wrappedLegacyItem = { id: { product_id: 3, price: 10 }, quantity: 1 };
  const res3 = sandbox.buildCanonicalSelectionsFromCart([wrappedLegacyItem]);
  eq(res3.ambiguousItems.length, 1, 'item con id como objeto (shape envuelto) se marca como ambiguo');

  // Mezcla: uno reconstruible + uno ambiguo -> el reconstruible SÍ se serializa.
  const mixed = sandbox.buildCanonicalSelectionsFromCart([legacyPriceCartItem, legacyVariantItem]);
  eq(mixed.selections.length, 1, 'en un carrito mixto, el item reconstruible se serializa igualmente');
  eq(mixed.ambiguousItems.length, 1, 'y el ambiguo se reporta aparte, sin bloquear al otro');
}

// =======================================================================
// P0E-B4B hardening, sección 6 - Regla definitiva de selectionSchemaVersion
// =======================================================================
function checkSelectionSchemaVersionLegacyRule() {
  const sandbox = loadCheckoutSandbox();

  // A. item pre-B2: ni selectionSchemaVersion ni variantOptionIds -> bloqueado.
  const preB2Item = { id: 8, quantity: 1, name: 'Producto viejo', price: 49.95 };
  ok(sandbox.isAmbiguousLegacyItem(preB2Item), 'A: item pre-B2 sin selectionSchemaVersion ni variantOptionIds está bloqueado');

  // B. item antiguo que pasó por normalizeCart (variantOptionIds:[] añadido)
  // pero SIGUE sin selectionSchemaVersion -> sigue bloqueado. Caso crítico:
  // el array vacío por sí solo NUNCA es prueba de contrato canónico.
  const normalizedLegacyItem = { id: 8, quantity: 1, name: 'Producto viejo', price: 49.95, variantOptionIds: [] };
  ok(sandbox.isAmbiguousLegacyItem(normalizedLegacyItem), 'B (CRÍTICO): item legacy con variantOptionIds:[] añadido por normalizeCart pero sin selectionSchemaVersion sigue bloqueado');
  const resB = sandbox.buildCanonicalSelectionsFromCart([normalizedLegacyItem]);
  eq(resB.selections.length, 0, 'B: no se serializa ninguna selección para ese item');
  eq(resB.ambiguousItems.length, 1, 'B: se reporta como ambiguo');

  // C. item nuevo: selectionSchemaVersion:1, variantOptionIds:[] -> válido.
  const newItemNoVariants = { id: 8, quantity: 1, selectionSchemaVersion: 1, variantOptionIds: [] };
  ok(!sandbox.isAmbiguousLegacyItem(newItemNoVariants), 'C: item nuevo con selectionSchemaVersion:1 y variantOptionIds:[] es válido');
  const resC = sandbox.buildCanonicalSelectionsFromCart([newItemNoVariants]);
  eq(resC.ambiguousItems.length, 0, 'C: no se marca como ambiguo');
  eq(resC.selections.length, 1, 'C: se serializa');

  // D. item nuevo: selectionSchemaVersion:1, variantOptionIds:[5,8] -> válido.
  const newItemWithVariants = { id: 8, quantity: 1, selectionSchemaVersion: 1, variantOptionIds: [5, 8] };
  ok(!sandbox.isAmbiguousLegacyItem(newItemWithVariants), 'D: item nuevo con selectionSchemaVersion:1 y variantOptionIds:[5,8] es válido');
  const resD = sandbox.buildCanonicalSelectionsFromCart([newItemWithVariants]);
  eq(resD.ambiguousItems.length, 0, 'D: no se marca como ambiguo');
  eq(JSON.stringify(resD.selections[0].variantOptionIds), JSON.stringify([5, 8]), 'D: variantOptionIds se conserva');
}

// =======================================================================
// Sección 37 - Idempotency/access token frontend
// =======================================================================
function checkCheckoutAttempt() {
  const sandbox = loadCheckoutSandbox();

  const token = sandbox.generateSecureToken();
  ok(/^[0-9a-f]{64}$/.test(token), 'generateSecureToken produce 64 hex minúscula (mismo contrato que B3 accessToken)');
  const token2 = sandbox.generateSecureToken();
  ok(token !== token2, 'dos llamadas producen tokens distintos (CSPRNG real, no determinista)');

  const selections = [{ productId: 8, quantity: 1, modelId: null, variantOptionIds: [], extras: { upscale: false, qr: false, adapter: false, qrMessage: '' }, images: [], notes: '' }];
  const attempt1 = sandbox.getOrCreateCheckoutAttempt(selections);
  ok(/^[0-9a-f]{64}$/.test(attempt1.idempotencyKey) && /^[0-9a-f]{64}$/.test(attempt1.accessToken), 'idempotencyKey y accessToken tienen la misma entropía (64 hex)');

  // "Refresh": nueva carga de página (nuevo sandbox = nuevo estado JS), MISMO
  // sessionStorage subyacente y MISMAS selecciones -> debe reutilizar el intento.
  const sandboxAfterRefresh = loadCheckoutSandbox({ sessionStore: sandbox.sessionStorage._store });
  const attemptAfterRefresh = sandboxAfterRefresh.getOrCreateCheckoutAttempt(selections);
  eq(attemptAfterRefresh.idempotencyKey, attempt1.idempotencyKey, 'tras un refresh con las MISMAS selecciones, se reutiliza el mismo idempotencyKey');
  eq(attemptAfterRefresh.accessToken, attempt1.accessToken, 'tras un refresh con las MISMAS selecciones, se reutiliza el mismo accessToken');

  // Retry de red (mismo proceso, sin refresh, MISMAS selecciones) -> mismo intento.
  // (Debe comprobarse ANTES de cambiar las selecciones: getOrCreateCheckoutAttempt
  // sobrescribe el intento guardado en sessionStorage cada vez que genera uno nuevo.)
  const attemptRetry = sandbox.getOrCreateCheckoutAttempt(selections);
  eq(attemptRetry.idempotencyKey, attempt1.idempotencyKey, 'un retry sin cambiar selecciones reutiliza el mismo idempotencyKey (nunca se regenera solo por un error de red)');

  // Cambiar las selecciones -> nuevo intento.
  const changedSelections = [{ ...selections[0], quantity: 2 }];
  const attemptChanged = sandbox.getOrCreateCheckoutAttempt(changedSelections);
  ok(attemptChanged.idempotencyKey !== attempt1.idempotencyKey, 'selecciones distintas -> idempotencyKey NUEVA');
  ok(attemptChanged.accessToken !== attempt1.accessToken, 'selecciones distintas -> accessToken NUEVO');

  // El access token nunca debe construirse dentro de una URL/query string.
  const src = readScript('public/js/checkout.js');
  ok(!/[?&]accessToken=/.test(src), 'checkout.js no debe construir nunca una URL con accessToken como query string');
  ok(/body:\s*JSON\.stringify/.test(src), 'accessToken viaja en el body JSON, no en la URL');
}

// =======================================================================
// Sección 38 - Orden de pago: PATCH antes de stripe.confirmPayment
// =======================================================================
async function checkPayOrderSequencing() {
  // --- PATCH OK -> stripe.confirmPayment SÍ se llama ---
  {
    const form = makeFormStub();
    const sandbox = loadCheckoutSandbox({ form });
    let confirmPaymentCalled = false;
    sandbox.__confirmPaymentImpl = async () => { confirmPaymentCalled = true; return { error: null, paymentIntent: { status: 'requires_action' } }; };
    sandbox.fetch = async (url) => {
      if (String(url).includes('/api/checkout-draft/customer-data')) {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: false, json: async () => ({ ok: false, error: 'no debería llamarse a otra URL en este test' }) };
    };
    runIn(sandbox, `
      currentBreakdown = { totals: { totalCents: 1000 }, currency: 'eur' };
      clientSecret = 'cs_test';
      currentAttempt = { idempotencyKey: 'k'.repeat(4), accessToken: 'a'.repeat(64) };
      stripe = { confirmPayment: __confirmPaymentImpl };
      elements = {};
    `);
    await runIn(sandbox, 'handleCheckout({ preventDefault(){} })');
    ok(confirmPaymentCalled, 'PATCH customer-data OK -> stripe.confirmPayment() SÍ se llama');
  }

  // --- PATCH FAIL -> stripe.confirmPayment NO se llama ---
  {
    const form = makeFormStub();
    const sandbox = loadCheckoutSandbox({ form });
    let confirmPaymentCalled = false;
    sandbox.__confirmPaymentImpl = async () => { confirmPaymentCalled = true; return { error: null, paymentIntent: { status: 'succeeded' } }; };
    sandbox.fetch = async (url) => {
      if (String(url).includes('/api/checkout-draft/customer-data')) {
        return { ok: false, json: async () => ({ ok: false, error: 'access_denied' }) };
      }
      return { ok: false, json: async () => ({ ok: false }) };
    };
    runIn(sandbox, `
      currentBreakdown = { totals: { totalCents: 1000 }, currency: 'eur' };
      clientSecret = 'cs_test';
      currentAttempt = { idempotencyKey: 'k'.repeat(4), accessToken: 'a'.repeat(64) };
      stripe = { confirmPayment: __confirmPaymentImpl };
      elements = {};
    `);
    await runIn(sandbox, 'handleCheckout({ preventDefault(){} })');
    eq(confirmPaymentCalled, false, 'PATCH customer-data FALLA -> stripe.confirmPayment() NUNCA se llama');
  }
}

// =======================================================================
// Sección 39 - El breakdown mostrado viene del servidor, nunca de localStorage
// =======================================================================
async function checkBreakdownAuthority() {
  const form = makeFormStub();
  const sandbox = loadCheckoutSandbox({ form });

  // Carrito local con un precio manipulado (0.01) -- exactamente el ataque
  // descrito en la sección 39 del ticket.
  runIn(sandbox, `localStorage.setItem('litum3d_cart', JSON.stringify([
    { id: 8, quantity: 1, selectionSchemaVersion: 1, price: 0.01, basePrice: 0.01, modelId: null, variantOptionIds: [], extras: { upscale: false, qr: false, adapter: false, qrMessage: '' }, images: [], notes: '' }
  ]))`);

  sandbox.fetch = async (url) => {
    if (String(url).includes('/api/create-payment-intent')) {
      return {
        ok: true,
        json: async () => ({
          ok: true, draftId: 1, reused: false, clientSecret: 'cs_test', paymentIntentId: 'pi_test', paymentIntentStatus: 'requires_payment_method',
          currency: 'eur',
          totals: { subtotalCents: 4995, shippingCents: 0, totalCents: 4995, netCents: 4128, taxCents: 867 },
          items: [{ productId: 8, productName: 'Litofanía', quantity: 1, modelName: null, variantSelections: [], extras: { upscale: false, qr: false, adapter: false, qrMessage: '' }, unitPriceCents: 4995 }]
        })
      };
    }
    return { ok: false, json: async () => ({ ok: false }) };
  };
  runIn(sandbox, `stripe = { elements: () => ({ create: () => ({ mount() {} }) }) };`);

  await runIn(sandbox, 'prepareCheckout()');

  const totalAmountEl = sandbox.document.getElementById('total-amount');
  eq(totalAmountEl.textContent, '49.95', 'el total mostrado (49.95) viene del breakdown SERVER-SIDE, no de localStorage price=0.01');

  const summaryEl = sandbox.document.getElementById('order-summary');
  ok(!summaryEl.innerHTML.includes('0.01') && !summaryEl.innerHTML.includes('0,01'), 'el resumen renderizado no debe mostrar en ningún sitio el precio manipulado de localStorage (0.01)');
  ok(summaryEl.innerHTML.includes('49,95') || summaryEl.innerHTML.includes('49.95'), 'el resumen renderizado SÍ muestra el importe autoritativo del servidor (49.95)');

  ok(form._submitBtn.disabled === false, 'el botón de pagar se habilita SOLO tras recibir un breakdown válido del servidor');
}

// =======================================================================
// Sección 29 - PI ya succeeded al cargar (retry tras perder la respuesta)
// =======================================================================
async function checkAlreadySucceededSkipsPaymentElement() {
  const form = makeFormStub();
  const sandbox = loadCheckoutSandbox({ form });
  runIn(sandbox, `localStorage.setItem('litum3d_cart', JSON.stringify([
    { id: 8, quantity: 1, selectionSchemaVersion: 1, modelId: null, variantOptionIds: [], extras: { upscale: false, qr: false, adapter: false, qrMessage: '' }, images: [], notes: '' }
  ]))`);

  let confirmPaymentCalls = 0;
  sandbox.fetch = async (url) => {
    if (String(url).includes('/api/create-payment-intent')) {
      return {
        ok: true,
        json: async () => ({
          ok: true, draftId: 1, reused: true, clientSecret: 'cs_test', paymentIntentId: 'pi_already_paid', paymentIntentStatus: 'succeeded',
          currency: 'eur',
          totals: { subtotalCents: 4995, shippingCents: 0, totalCents: 4995, netCents: 4128, taxCents: 867 },
          items: [{ productId: 8, productName: 'Litofanía', quantity: 1, modelName: null, variantSelections: [], extras: { upscale: false, qr: false, adapter: false, qrMessage: '' }, unitPriceCents: 4995 }]
        })
      };
    }
    if (String(url).includes('/api/confirm-payment')) {
      confirmPaymentCalls++;
      return { ok: true, json: async () => ({ ok: true, orderId: 321, created: false }) };
    }
    return { ok: false, json: async () => ({ ok: false }) };
  };
  runIn(sandbox, `stripe = { elements: () => { globalThis.__elementsCalled = true; return { create: () => ({ mount() {} }) }; } };`);

  await runIn(sandbox, 'prepareCheckout()');

  eq(sandbox.__elementsCalled, undefined, 'con paymentIntentStatus="succeeded" NUNCA se debe montar un Payment Element (no se intenta cobrar dos veces)');
  eq(confirmPaymentCalls, 1, 'con paymentIntentStatus="succeeded" al cargar, se reconcilia directamente vía /api/confirm-payment');
}

// =======================================================================
// Sección 28 - PI canceled: no se monta Payment Element, se invalida el intento
// =======================================================================
async function checkCanceledPaymentIntentInvalidatesAttempt() {
  const form = makeFormStub();
  const sandbox = loadCheckoutSandbox({ form });
  runIn(sandbox, `localStorage.setItem('litum3d_cart', JSON.stringify([
    { id: 8, quantity: 1, selectionSchemaVersion: 1, modelId: null, variantOptionIds: [], extras: { upscale: false, qr: false, adapter: false, qrMessage: '' }, images: [], notes: '' }
  ]))`);

  let createCalls = 0;
  const seenIdempotencyKeys = [];
  sandbox.fetch = async (url, opts) => {
    if (String(url).includes('/api/create-payment-intent')) {
      createCalls++;
      const body = JSON.parse(opts.body);
      seenIdempotencyKeys.push(body.idempotencyKey);
      // Primera respuesta: PI canceled. Segunda (tras regenerar credenciales): PI usable.
      const status = createCalls === 1 ? 'canceled' : 'requires_payment_method';
      return {
        ok: true,
        json: async () => ({
          ok: true, draftId: createCalls, reused: false, clientSecret: 'cs_test', paymentIntentId: `pi_${createCalls}`, paymentIntentStatus: status,
          currency: 'eur',
          totals: { subtotalCents: 4995, shippingCents: 0, totalCents: 4995, netCents: 4128, taxCents: 867 },
          items: [{ productId: 8, productName: 'Litofanía', quantity: 1, modelName: null, variantSelections: [], extras: { upscale: false, qr: false, adapter: false, qrMessage: '' }, unitPriceCents: 4995 }]
        })
      };
    }
    return { ok: false, json: async () => ({ ok: false }) };
  };
  runIn(sandbox, `stripe = { elements: () => ({ create: () => ({ mount() {} }) }) };`);

  await runIn(sandbox, 'prepareCheckout()');

  eq(createCalls, 2, 'un PI canceled debe generar EXACTAMENTE un reintento automático con credenciales nuevas (no un bucle)');
  ok(seenIdempotencyKeys[0] !== seenIdempotencyKeys[1], 'el reintento tras un PI canceled usa una idempotencyKey NUEVA, nunca la del draft canceled');
  ok(form._submitBtn.disabled === false, 'tras recuperarse de un PI canceled con un draft nuevo usable, el botón de pagar se habilita');
}

// =======================================================================
// Hardening final, sección 1/5 - reconcilePayment redirige por
// payment_intent (nunca orderId) y limpia cart/attempt EN CUANTO el
// backend confirma ok:true, ANTES de navegar a success. Es el test
// principal de esta ronda: si el usuario cierra la pestaña justo después
// de la confirmación backend pero antes de llegar a /success, el carrito
// ya pagado no debe sobrevivir en localStorage (evita una segunda compra
// accidental del mismo carrito en una sesión futura).
// =======================================================================
async function checkReconcilePaymentCleansUpBeforeRedirectOnBackendSuccess() {
  const sandbox = loadCheckoutSandbox();
  runIn(sandbox, `localStorage.setItem('litum3d_cart', JSON.stringify([{ id: 8 }]))`);
  runIn(sandbox, `sessionStorage.setItem('litum3d_checkout_attempt_v1', JSON.stringify({ idempotencyKey: 'k', accessToken: 'a' }))`);

  let confirmPaymentBody = null;
  sandbox.fetch = async (url, opts) => {
    if (String(url).includes('/api/confirm-payment')) {
      confirmPaymentBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ ok: true, orderId: 55, created: true }) };
    }
    return { ok: false, json: async () => ({ ok: false }) };
  };

  await runIn(sandbox, `reconcilePayment('pi_test_123')`);

  eq(confirmPaymentBody.paymentIntentId, 'pi_test_123', 'reconcilePayment envía SOLO paymentIntentId al backend');
  eq(sandbox.window.location.href, '/success?payment_intent=pi_test_123', 'reconcilePayment redirige a success con ?payment_intent=, NUNCA con ?orderId=');
  ok(!sandbox.window.location.href.includes('orderId'), 'la URL de redirect nunca contiene orderId');

  // Test principal (sección 5 del hardening final): simula "pestaña cerrada"
  // -- nunca se ejecuta success.js -- y comprueba que el cierre YA ocurrió
  // en checkout.js, antes/independientemente de que el navegador llegara a
  // procesar el redirect.
  eq(runIn(sandbox, `localStorage.getItem('litum3d_cart')`), null, 'CRÍTICO: tras ok:true del backend, checkout.js ya limpió litum3d_cart -- ningún carrito ya pagado sobrevive si la pestaña se cierra antes de llegar a success');
  eq(runIn(sandbox, `sessionStorage.getItem('litum3d_checkout_attempt_v1')`), null, 'CRÍTICO: tras ok:true del backend, checkout.js ya limpió litum3d_checkout_attempt_v1 por el mismo motivo');
}

async function checkReconcilePaymentKeepsCartOnBackendFailure() {
  const sandbox = loadCheckoutSandbox();
  runIn(sandbox, `localStorage.setItem('litum3d_cart', JSON.stringify([{ id: 8 }]))`);
  runIn(sandbox, `sessionStorage.setItem('litum3d_checkout_attempt_v1', JSON.stringify({ idempotencyKey: 'k', accessToken: 'a' }))`);

  sandbox.fetch = async (url) => {
    if (String(url).includes('/api/confirm-payment')) {
      return { ok: false, json: async () => ({ ok: false, error: 'timeout' }) };
    }
    return { ok: false, json: async () => ({ ok: false }) };
  };

  await runIn(sandbox, `reconcilePayment('pi_test_fail')`);

  ok(runIn(sandbox, `localStorage.getItem('litum3d_cart')`) !== null, 'si /api/confirm-payment falla (error/timeout), el carrito NUNCA se limpia -- Stripe succeeded por sí solo no basta');
  ok(runIn(sandbox, `sessionStorage.getItem('litum3d_checkout_attempt_v1')`) !== null, 'si /api/confirm-payment falla, el checkout attempt NUNCA se limpia -- debe poder reintentarse con el mismo intento');
  ok(sandbox.window.location.href === '' || !sandbox.window.location.href.includes('/success'), 'si /api/confirm-payment falla, nunca se navega a success');
}

async function main() {
  checkCanonicalSerializer();
  checkSelectionSchemaVersionLegacyRule();
  checkCheckoutAttempt();
  await checkPayOrderSequencing();
  await checkBreakdownAuthority();
  await checkAlreadySucceededSkipsPaymentElement();
  await checkCanceledPaymentIntentInvalidatesAttempt();
  await checkReconcilePaymentCleansUpBeforeRedirectOnBackendSuccess();
  await checkReconcilePaymentKeepsCartOnBackendFailure();
  console.log(`OK: ${checks} comprobaciones sobre public/js/checkout.js (serializador, selectionSchemaVersion, checkout attempt, orden de pago, breakdown autoritativo, succeeded/canceled, reconciliación por payment_intent, cleanup pre-redirect).`);
}

main().catch(err => {
  console.error('FALLO en check-checkout-frontend.js:', err.message, err.stack);
  process.exit(1);
});
