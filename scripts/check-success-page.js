/*
  LITUM3D - Tests de public/js/success.js (P0E-B4B, sección 40 + hardening
  final secciones 7-13).

  Carga success.js real en un sandbox vm con DOM/fetch simulados. Cubre:
    - ?payment_intent=pi_x en la URL -> llama a POST /api/confirm-payment
      SOLO con {paymentIntentId}, muestra éxito tras respuesta ok:true, y
      limpia cart/checkout attempt SOLO tras esa respuesta ok:true;
    - retry (createFalse) -> mismo orderId (idempotencia real garantizada
      por el backend, ya probada en check-checkout-routes.js; aquí se
      prueba que el frontend no envía nada más que el id en cada llamada);
    - ?orderId=N SIN payment_intent -> NUNCA muestra éxito (un query string
      controlado por el navegador no es evidencia de un pago confirmado) y
      NUNCA llama al backend con ese orderId;
    - sin payment_intent y sin orderId -> nunca se afirma éxito;
    - payment_intent presente pero backend rechaza -> nunca se afirma éxito;
    - amount/currency/orderId de la URL nunca se usan como autoridad, ni
      siquiera cuando vienen junto a un payment_intent válido.

  Uso: node scripts/check-success-page.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function readScript(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

function makeElementStub() {
  return { textContent: '', style: {}, addEventListener() {} };
}

function makeDocumentStub(lang) {
  const registry = new Map();
  return {
    documentElement: { lang },
    getElementById(id) {
      if (!registry.has(id)) registry.set(id, makeElementStub());
      return registry.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => makeElementStub(),
    addEventListener: () => {},
    _registry: registry
  };
}

function makeSessionStorageStub() {
  const store = new Map();
  return {
    _store: store,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
}

function loadSuccessSandbox({ search, lang = 'es', fetchImpl } = {}) {
  let clearCartCalls = 0;
  const sessionStorageStub = makeSessionStorageStub();
  sessionStorageStub.setItem('litum3d_checkout_attempt_v1', JSON.stringify({ idempotencyKey: 'k', accessToken: 'a' }));
  const sandbox = {
    console,
    document: makeDocumentStub(lang),
    window: { location: { search: search || '', pathname: '/success' } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: sessionStorageStub,
    fetch: fetchImpl || (async () => ({ ok: false, json: async () => ({ ok: false }) })),
    getCartCount: () => 0, // normalmente la aporta cart.js; no es el foco de este test
    clearCart: () => { clearCartCalls++; }, // normalmente la aporta cart.js
    URLSearchParams
  };
  vm.createContext(sandbox);
  vm.runInContext(readScript('public/js/success.js'), sandbox, { filename: 'success.js' });
  sandbox._getClearCartCalls = () => clearCartCalls;
  return sandbox;
}

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); checks++; }

async function checkPaymentIntentRedirectFlow() {
  const calls = [];
  const sandbox = loadSuccessSandbox({
    search: '?payment_intent=pi_test_123&payment_intent_client_secret=cs_should_be_ignored',
    fetchImpl: async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({ ok: true, orderId: 77, created: true }) };
    }
  });

  await vm.runInContext('initSuccessPage()', sandbox);
  // esperar a que la promesa interna de confirmPaymentIntent resuelva
  await new Promise(r => setTimeout(r, 0));

  eq(calls.length, 1, 'debe llamarse exactamente una vez a fetch');
  ok(calls[0].url.includes('/api/confirm-payment'), 'debe llamar a POST /api/confirm-payment');
  eq(Object.keys(calls[0].body).join(','), 'paymentIntentId', 'el body enviado contiene SOLO paymentIntentId (nada de amount/currency/cart de la URL)');
  eq(calls[0].body.paymentIntentId, 'pi_test_123', 'usa el payment_intent extraído de la URL, ignorando payment_intent_client_secret');

  const orderNumberEl = sandbox.document.getElementById('order-number');
  ok(orderNumberEl.textContent.includes('77'), 'tras ok:true del backend, se muestra el orderId devuelto por el backend');

  eq(sandbox._getClearCartCalls(), 1, 'sección 11: tras ok:true del backend, success.js limpia el carrito (único punto de cierre)');
  eq(sandbox.sessionStorage.getItem('litum3d_checkout_attempt_v1'), null, 'sección 11: tras ok:true del backend, success.js limpia el checkout attempt de sessionStorage');
}

async function checkRetryReturnsSameOrder() {
  let callCount = 0;
  const sandbox = loadSuccessSandbox({
    search: '?payment_intent=pi_retry',
    fetchImpl: async () => {
      callCount++;
      return { ok: true, json: async () => ({ ok: true, orderId: 99, created: callCount === 1 }) };
    }
  });
  await vm.runInContext('initSuccessPage()', sandbox);
  await new Promise(r => setTimeout(r, 0));
  const first = sandbox.document.getElementById('order-number').textContent;

  // Segunda carga de la misma página (mismo query string) -> mismo backend
  // idempotente devuelve el MISMO orderId (created:false la segunda vez).
  const sandbox2 = loadSuccessSandbox({
    search: '?payment_intent=pi_retry',
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, orderId: 99, created: false }) })
  });
  await vm.runInContext('initSuccessPage()', sandbox2);
  await new Promise(r => setTimeout(r, 0));
  const second = sandbox2.document.getElementById('order-number').textContent;

  eq(first, second, 'un retry de la reconciliación muestra el MISMO pedido (idempotencia del backend)');
}

async function checkBackendFailureNeverShowsFalseSuccess() {
  const sandbox = loadSuccessSandbox({
    search: '?payment_intent=pi_failed',
    fetchImpl: async () => ({ ok: false, json: async () => ({ ok: false, error: 'El pago todavía no se ha completado' }) })
  });
  await vm.runInContext('initSuccessPage()', sandbox);
  await new Promise(r => setTimeout(r, 0));

  const orderNumberEl = sandbox.document.getElementById('order-number');
  ok(!orderNumberEl.textContent.includes('undefined') && !/^\s*$/.test(orderNumberEl.textContent), 'debe mostrar un mensaje de error, no un hueco vacío');
  ok(!orderNumberEl.textContent.match(/#\d/), 'NUNCA debe mostrar un número de pedido si el backend no confirmó ok:true');
}

async function checkOrderIdAloneNeverAffirmsSuccess() {
  // Sección 9 del hardening final: ?orderId=N SIN payment_intent NUNCA es,
  // por sí solo, evidencia de un pedido confirmado (query string controlado
  // por el navegador). No debe llamarse al backend con ese orderId ni
  // mostrarse "confirmado" -- ni siquiera si el orderId "existe" de verdad.
  let fetchCalled = false;
  const sandbox = loadSuccessSandbox({
    search: '?orderId=55',
    fetchImpl: async () => { fetchCalled = true; return { ok: true, json: async () => ({ ok: true, orderId: 55, created: false }) }; }
  });
  await vm.runInContext('initSuccessPage()', sandbox);
  await new Promise(r => setTimeout(r, 0));

  eq(fetchCalled, false, '?orderId=55 sin payment_intent NUNCA debe llamar al backend');
  const text = sandbox.document.getElementById('order-number').textContent;
  ok(!text.match(/#\d/), '?orderId=55 sin payment_intent NUNCA muestra un pedido confirmado');
  eq(sandbox._getClearCartCalls(), 0, 'sin confirmación backend, el carrito NUNCA se limpia');
  ok(sandbox.sessionStorage.getItem('litum3d_checkout_attempt_v1') !== null, 'sin confirmación backend, el checkout attempt NUNCA se limpia');
}

async function checkUrlValuesNeverTrustedEvenAlongsidePaymentIntent() {
  // Sección 10/12-F: aunque la URL traiga orderId/amount/currency propios
  // (manipulados o no) JUNTO a un payment_intent válido, lo único que se usa
  // es el payment_intent -- el orderId mostrado SIEMPRE es el que devuelve
  // el backend, nunca el de la URL.
  let calls = [];
  const sandbox = loadSuccessSandbox({
    search: '?payment_intent=pi_real&orderId=999999&amount=1&currency=usd',
    fetchImpl: async (url, opts) => {
      calls.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ ok: true, orderId: 42, created: true }) };
    }
  });
  await vm.runInContext('initSuccessPage()', sandbox);
  await new Promise(r => setTimeout(r, 0));

  eq(calls.length, 1, 'se llama exactamente una vez al backend');
  eq(Object.keys(calls[0]).join(','), 'paymentIntentId', 'el body enviado nunca incluye orderId/amount/currency de la URL');
  const text = sandbox.document.getElementById('order-number').textContent;
  ok(text.includes('42') && !text.includes('999999'), 'el orderId mostrado es SIEMPRE el del backend (42), nunca el manipulado de la URL (999999)');
}

async function checkNoContextNeverAffirmsSuccess() {
  let fetchCalled = false;
  const sandbox = loadSuccessSandbox({
    search: '',
    fetchImpl: async () => { fetchCalled = true; return { ok: true, json: async () => ({ ok: true, orderId: 1 }) }; }
  });
  await vm.runInContext('initSuccessPage()', sandbox);
  await new Promise(r => setTimeout(r, 0));

  eq(fetchCalled, false, 'sin payment_intent ni orderId, no debe llamarse al backend');
  const text = sandbox.document.getElementById('order-number').textContent;
  ok(!text.match(/#\d/), 'sin payment_intent ni orderId en la URL, nunca se afirma un pedido confirmado');
}

async function main() {
  await checkPaymentIntentRedirectFlow();
  await checkRetryReturnsSameOrder();
  await checkBackendFailureNeverShowsFalseSuccess();
  await checkOrderIdAloneNeverAffirmsSuccess();
  await checkNoContextNeverAffirmsSuccess();
  await checkUrlValuesNeverTrustedEvenAlongsidePaymentIntent();
  console.log(`OK: ${checks} comprobaciones sobre la reconciliación de public/js/success.js.`);
}

main().catch(err => {
  console.error('FALLO en check-success-page.js:', err.message, err.stack);
  process.exit(1);
});
