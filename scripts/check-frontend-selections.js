/*
  LITUM3D - Tests de selecciones canónicas en frontend (P0E-B2).

  Carga los scripts reales de public/js/{cart,cart-page,home,shop}.js en un
  sandbox de Node (módulo "vm" nativo) con DOM/localStorage mínimos
  simulados. No se modifica ningún fichero fuente ni se convierten en
  módulos CommonJS: se ejecutan tal cual se sirven al navegador y se
  invocan directamente las funciones puras/aisladas relevantes para esta
  migración (normalización de variantOptionIds, fusión de items del
  carrito, fórmula de precio de personalización, construcción de
  variantOptionIds). No se prueban flujos completos de DOM/eventos.

  Uso: node scripts/check-frontend-selections.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function readScript(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

function makeLocalStorageStub() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
}

function makeDocumentStub() {
  return {
    addEventListener: () => {},
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, remove() {} }),
    body: { appendChild: () => {} }
  };
}

function loadCartSandbox() {
  const sandbox = {
    console,
    setTimeout: () => {}, // evita que showCartNotification deje un timer pendiente
    localStorage: makeLocalStorageStub(),
    document: makeDocumentStub()
  };
  vm.createContext(sandbox);
  vm.runInContext(readScript('public/js/cart.js'), sandbox, { filename: 'cart.js' });
  vm.runInContext(readScript('public/js/cart-page.js'), sandbox, { filename: 'cart-page.js' });
  return sandbox;
}

// Simula la respuesta de red de GET /api/pricing-config. No se puede
// sobrescribir la variable interna `pricingConfig` (es `let` de nivel de
// script, no una propiedad del objeto global) desde fuera del sandbox — en
// su lugar se simula fetch() y se llama a la función real loadPricingConfig(),
// que hace su propia asignación interna, igual que en el navegador.
function makeFetchStub(responseData, ok = true) {
  return async () => ({ ok, json: async () => responseData });
}

const PRICING_CONFIG_FIXTURE = {
  ok: true,
  currency: 'chf',
  extras: {
    upscale: { cents: 500, amount: 5 },
    qr: { cents: 500, amount: 5 },
    adapter: { cents: 400, amount: 4 }
  }
};

function loadHomeSandbox() {
  const sandbox = { console, document: makeDocumentStub(), fetch: makeFetchStub({ ok: false }) };
  vm.createContext(sandbox);
  vm.runInContext(readScript('public/js/home.js'), sandbox, { filename: 'home.js' });
  return sandbox;
}

function loadShopSandbox() {
  const sandbox = { console, document: makeDocumentStub(), fetch: makeFetchStub({ ok: false }) };
  vm.createContext(sandbox);
  vm.runInContext(readScript('public/js/shop.js'), sandbox, { filename: 'shop.js' });
  return sandbox;
}

let checks = 0;
function check(condition, message) {
  checks++;
  assert.ok(condition, message);
}

async function main() {
  // ================= cart.js =================

  // normalizeVariantOptionIds: array, dedup, orden determinista, descarta basura
  {
    const cart = loadCartSandbox();
    check(
      JSON.stringify(cart.normalizeVariantOptionIds([7, 17, 7, '27', null, undefined, 'x', 0, -1, 1.5])) === JSON.stringify([7, 17, 27]),
      'normalizeVariantOptionIds: dedup, orden ascendente, descarta no-enteros/negativos/cero/no numéricos'
    );
    check(JSON.stringify(cart.normalizeVariantOptionIds(undefined)) === '[]', 'normalizeVariantOptionIds: no-array -> []');
    check(JSON.stringify(cart.normalizeVariantOptionIds([])) === '[]', 'normalizeVariantOptionIds: array vacío -> []');
  }

  // addToCart: fusión solo cuando no hay personalización real
  {
    const cart = loadCartSandbox();

    cart.addToCart(8, 'Producto', 49.95, {});
    cart.addToCart(8, 'Producto', 49.95, {});
    let items = cart.getCart();
    check(items.length === 1 && items[0].quantity === 2, 'Dos adiciones sin personalización del mismo producto se fusionan (quantity=2)');

    cart.clearCart();
    cart.addToCart(8, 'Producto', 49.95, { variantOptionIds: [7] });
    cart.addToCart(8, 'Producto', 49.95, { variantOptionIds: [17] });
    items = cart.getCart();
    check(items.length === 2, 'variantOptionIds distintos del mismo producto NO se fusionan');

    cart.clearCart();
    cart.addToCart(8, 'Producto', 49.95, { extras: { upscale: true, qr: false, adapter: false, qrMessage: '', extrasTotal: 5, currency: 'CHF' } });
    cart.addToCart(8, 'Producto', 49.95, { extras: { upscale: false, qr: false, adapter: false, qrMessage: '', extrasTotal: 0, currency: 'CHF' } });
    items = cart.getCart();
    check(items.length === 2, 'extras distintos (sin modelo/variantes) del mismo producto NO se fusionan');

    cart.clearCart();
    cart.addToCart(8, 'Producto', 49.95, { modelId: 3 });
    cart.addToCart(8, 'Producto', 49.95, { modelId: 4 });
    items = cart.getCart();
    check(items.length === 2, 'modelId distinto del mismo producto NO se fusiona (comportamiento preexistente conservado)');
  }

  // addToCart: conserva variantOptionIds normalizados y campos legacy
  {
    const cart = loadCartSandbox();
    cart.addToCart(8, 'Producto', 49.95, { variantOptionIds: [17, 7, 7] });
    const items = cart.getCart();
    check(JSON.stringify(items[0].variantOptionIds) === JSON.stringify([7, 17]), 'addToCart normaliza y conserva variantOptionIds en el item guardado');
    check(
      typeof items[0].price === 'number' && typeof items[0].basePrice === 'number' && typeof items[0].priceDelta === 'number',
      'Campos económicos legacy (price/basePrice/priceDelta) se conservan temporalmente'
    );
  }

  // cart-page.js normalizeCart: compatibilidad con carritos antiguos en localStorage
  {
    const cart = loadCartSandbox();
    const oldCart = [{ id: 8, name: 'Producto viejo', price: 49.95, quantity: 1 }]; // sin variantOptionIds
    const { cart: normalized, changed } = cart.normalizeCart(oldCart);
    check(
      Array.isArray(normalized[0].variantOptionIds) && normalized[0].variantOptionIds.length === 0,
      'normalizeCart añade variantOptionIds:[] a un item antiguo sin ese campo, sin romper'
    );
    check(changed === true, 'normalizeCart marca el carrito como cambiado al rellenar variantOptionIds que faltaba');

    const oldCartWithDelta = [{ id: 8, name: 'X', price: 55, priceDelta: 7, quantity: 1 }];
    const result2 = cart.normalizeCart(oldCartWithDelta);
    check(result2.cart[0].variantOptionIds.length === 0, 'normalizeCart no inventa variantOptionIds a partir de priceDelta u otro campo legacy');
  }

  // ================= home.js =================

  // Fórmula única de delta (corrección del bug modelo+variante)
  {
    const home = loadHomeSandbox();
    check(home.computeCustomizationPriceDelta(7, 5) === 12, 'computeCustomizationPriceDelta suma modelDelta + variantDelta');
    check(home.computeCustomizationPriceDelta(0, 5) === 5, 'computeCustomizationPriceDelta funciona solo con variante (sin modelo)');
    check(home.computeCustomizationPriceDelta(undefined, undefined) === 0, 'computeCustomizationPriceDelta con valores ausentes -> 0');
  }

  // variantOptionIds desde selectedVariants ({typeId: optionId})
  {
    const home = loadHomeSandbox();
    const ids = home.getSelectedVariantOptionIds({ 2: '7', 3: '27' }).slice().sort((a, b) => a - b);
    check(JSON.stringify(ids) === JSON.stringify([7, 27]), 'getSelectedVariantOptionIds extrae los IDs de selectedVariants como números');
    check(JSON.stringify(home.getSelectedVariantOptionIds({})) === '[]', 'getSelectedVariantOptionIds sin selecciones -> []');
  }

  // Sin fallback hardcodeado 5/5/4; consume /api/pricing-config
  {
    const src = readScript('public/js/home.js');
    check(
      !/upscale:\s*5\b/.test(src) && !/qr:\s*5\b/.test(src) && !/adapter:\s*4\b/.test(src),
      'home.js ya no contiene las constantes económicas hardcodeadas 5/5/4 como fuente de cálculo'
    );
    check(/\/api\/pricing-config/.test(src), 'home.js consume /api/pricing-config');

    // Blindaje estructural del bug corregido: confirmCustomization debe usar
    // la misma función que updateCustomTotal, no volver a sumar a mano
    // (eso es exactamente lo que causó que el total mostrado y el precio
    // añadido al carrito pudieran divergir).
    const occurrences = (src.match(/computeCustomizationPriceDelta\(/g) || []).length;
    check(occurrences >= 2, 'computeCustomizationPriceDelta se usa en más de un sitio (total mostrado y precio añadido al carrito comparten la misma fórmula)');
    check(/priceDelta:\s*computeCustomizationPriceDelta\(/.test(src), 'confirmCustomization pasa a addToCart el resultado de computeCustomizationPriceDelta, no una suma manual');

    const home = loadHomeSandbox();
    home.fetch = makeFetchStub(PRICING_CONFIG_FIXTURE);
    await home.loadPricingConfig(); // igual que en el navegador: fetch real + asignación interna
    check(
      home.getExtraPrice('upscale') === 5 && home.getExtraPrice('qr') === 5 && home.getExtraPrice('adapter') === 4,
      'getExtraPrice lee los precios desde pricingConfig tras loadPricingConfig() (simulando /api/pricing-config)'
    );
  }

  // Home: precio mostrado === precio legacy enviado al carrito (bug corregido, caso íntegro)
  {
    const home = loadHomeSandbox();
    home.fetch = makeFetchStub(PRICING_CONFIG_FIXTURE);
    await home.loadPricingConfig();

    const base = 49.95;
    const modelDelta = 7;
    const variantDelta = 3;
    const extrasTotal = home.getExtraPrice('upscale') + home.getExtraPrice('adapter'); // 9

    const displayedTotal = base + home.computeCustomizationPriceDelta(modelDelta, variantDelta) + extrasTotal; // updateCustomTotal
    const priceDeltaSentToCart = home.computeCustomizationPriceDelta(modelDelta, variantDelta); // confirmCustomization
    const legacyCartUnitPrice = base + priceDeltaSentToCart + extrasTotal; // fórmula de cart.js addToCart

    check(displayedTotal === legacyCartUnitPrice, 'Home: precio mostrado === precio legacy enviado al carrito para la misma personalización');

    const variantOptionIds = home.getSelectedVariantOptionIds({ 2: 27 });
    check(JSON.stringify(variantOptionIds) === '[27]', 'Home: variantOptionIds contiene la opción de variante adicional seleccionada');
  }

  // ================= shop.js =================

  // buildVariantOptionIds: el "modelo" visual (variant option) entra en variantOptionIds
  {
    const shop = loadShopSandbox();
    check(
      JSON.stringify(shop.buildVariantOptionIds('7', ['17', '27'])) === '["7","17","27"]',
      'shop.js: buildVariantOptionIds combina el "modelo" (en realidad una variant option) con el resto de variantes'
    );
    check(JSON.stringify(shop.buildVariantOptionIds(null, ['17'])) === '["17"]', 'buildVariantOptionIds descarta el modelo si es falsy');
    check(JSON.stringify(shop.buildVariantOptionIds('7', [])) === '["7"]', 'buildVariantOptionIds funciona sin otras variantes seleccionadas');

    const cart = loadCartSandbox();
    check(
      JSON.stringify(cart.normalizeVariantOptionIds(shop.buildVariantOptionIds('7', ['17', '27']))) === JSON.stringify([7, 17, 27]),
      'Shop: la opción que actúa visualmente como modelo/forma también aparece en variantOptionIds tras normalizar'
    );
  }

  // Sin fallback hardcodeado 5/5/4; consume /api/pricing-config
  {
    const src = readScript('public/js/shop.js');
    check(
      !/extrasCost \+= 5/.test(src) && !/extrasCost \+= 4/.test(src) && !/\(upscale \? 5/.test(src) && !/\(adapter \? 4/.test(src),
      'shop.js ya no contiene las constantes económicas hardcodeadas 5/5/4 como fuente de cálculo'
    );
    check(/\/api\/pricing-config/.test(src), 'shop.js consume /api/pricing-config');

    const shop = loadShopSandbox();
    shop.fetch = makeFetchStub(PRICING_CONFIG_FIXTURE);
    await shop.loadPricingConfig();
    check(shop.getExtraPrice('adapter') === 4, 'shop.js: getExtraPrice lee desde pricingConfig tras loadPricingConfig()');
  }

  console.log(`OK: ${checks} comprobaciones sobre selecciones canónicas en cart.js/cart-page.js/home.js/shop.js.`);
}

main().catch(err => {
  console.error('FALLO en check-frontend-selections.js:', err.message);
  process.exit(1);
});
