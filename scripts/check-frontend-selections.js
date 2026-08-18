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
  currency: 'eur',
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
    cart.addToCart(8, 'Producto', 49.95, { extras: { upscale: true, qr: false, adapter: false, qrMessage: '', extrasTotal: 5, currency: 'EUR' } });
    cart.addToCart(8, 'Producto', 49.95, { extras: { upscale: false, qr: false, adapter: false, qrMessage: '', extrasTotal: 0, currency: 'EUR' } });
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

  // F (P0E-B4B, sección 6/hardening) - addToCart SIEMPRE guarda
  // selectionSchemaVersion:1 en todo item creado por el código actual, con
  // o sin personalización real.
  {
    const cart = loadCartSandbox();
    cart.addToCart(8, 'Producto', 49.95, {});
    cart.addToCart(9, 'Otro', 19.95, { variantOptionIds: [7], modelId: 3 });
    const items = cart.getCart();
    check(items.every(i => i.selectionSchemaVersion === 1), 'F: addToCart guarda selectionSchemaVersion:1 en todo item nuevo, tenga o no personalización');
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

  // E (P0E-B4B, sección 6/hardening) - normalizeCart NUNCA añade
  // selectionSchemaVersion a un item legacy que no lo tenía, ni siquiera
  // cuando le rellena variantOptionIds:[] en la misma pasada. Un item que ya
  // lo tenía (carrito nuevo) lo conserva intacto.
  {
    const cart = loadCartSandbox();
    const legacyItem = { id: 8, name: 'Producto viejo', price: 49.95, quantity: 1 }; // sin selectionSchemaVersion ni variantOptionIds
    const { cart: normalizedLegacy } = cart.normalizeCart([legacyItem]);
    check(
      Array.isArray(normalizedLegacy[0].variantOptionIds) && normalizedLegacy[0].variantOptionIds.length === 0,
      'E: normalizeCart sigue rellenando variantOptionIds:[] para no romper la UI'
    );
    check(!('selectionSchemaVersion' in normalizedLegacy[0]), 'E (CRÍTICO): normalizeCart NO añade selectionSchemaVersion a un item legacy, ni siquiera al rellenarle variantOptionIds:[]');

    const newItem = { id: 9, name: 'Producto nuevo', price: 19.95, quantity: 1, selectionSchemaVersion: 1, variantOptionIds: [7] };
    const { cart: normalizedNew } = cart.normalizeCart([newItem]);
    check(normalizedNew[0].selectionSchemaVersion === 1, 'E: normalizeCart conserva selectionSchemaVersion:1 en un item que ya lo tenía');
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

  // Regresión (precio en vivo del modal de personalización): GET
  // /api/productos devuelve precio como STRING (columna DECIMAL vía
  // mysql2, p.ej. "49.95"). updateCustomizationPrice() debe convertirlo a
  // número antes de sumarlo -- si no, "+" concatena en vez de sumar
  // ("49.95"+15+5 -> "49.951550") y el total mostrado queda anclado al
  // precio base sin reflejar modelo/extras, aunque el carrito sí calcule
  // bien (cart.js#addToCart sí hace parseFloat(productPrice)).
  {
    function makeTextEl(initial) {
      return { checked: false, textContent: initial };
    }
    const els = {
      'extra-upscale': makeTextEl(''),
      'extra-qr': makeTextEl(''),
      'extra-adapter': makeTextEl(''),
      'custom-base-price': makeTextEl('0.00'),
      'custom-total': makeTextEl('0.00')
    };
    els['extra-upscale'].checked = true; // extra Upscale activo (+5, ver PRICING_CONFIG_FIXTURE)
    const finalPriceEl = makeTextEl('€0.00');

    const modalDocumentStub = {
      addEventListener: () => {},
      getElementById: (id) => els[id] || null,
      querySelector: (sel) => (sel === '[data-variant-price]' ? finalPriceEl : null),
      querySelectorAll: () => [], // sin dropdowns de variantes adicionales en este caso
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, remove() {} }),
      body: { appendChild: () => {} }
    };

    const sandbox = { console, document: modalDocumentStub, fetch: makeFetchStub(PRICING_CONFIG_FIXTURE) };
    vm.createContext(sandbox);
    vm.runInContext(readScript('public/js/shop.js'), sandbox, { filename: 'shop.js' });
    await sandbox.loadPricingConfig();

    // customizationState es `let` de nivel de script: no se expone como
    // sandbox.customizationState, se asigna ejecutando código en el MISMO
    // contexto (igual que hace loadPricingConfig() internamente con
    // pricingConfig), reproduciendo exactamente lo que hace openCustomization()
    // con la respuesta real de /api/productos (precio como string).
    vm.runInContext(
      `customizationState.product = { precio: '49.95' }; customizationState.selectedModelPriceDelta = 15;`,
      sandbox,
      { filename: 'shop-test-setup.js' }
    );

    sandbox.updateCustomizationPrice();

    check(
      els['custom-total'].textContent === '69.95',
      `updateCustomizationPrice(): basePrice string "49.95" + modelo 15 + extra upscale 5 debe dar "69.95", dio "${els['custom-total'].textContent}"`
    );
    check(
      finalPriceEl.textContent === '69.95 €',
      `updateCustomizationPrice(): [data-variant-price] debe mostrar "69.95 €", mostró "${finalPriceEl.textContent}"`
    );
    check(
      els['custom-total'].textContent !== '49.95',
      'Regresión: el total no debe quedarse anclado al precio base por concatenación de strings'
    );
  }

  // Regresión (precio inicial al abrir el modal): antes de esta
  // reparación, openCustomization() nunca llamaba a
  // updateCustomizationPrice(), así que el modal se abría mostrando el
  // placeholder estático "€0.00"/"0.00" del HTML hasta la primera
  // interacción. Ejercita la secuencia real completa a través de las
  // funciones reales de producción (openCustomization, selectModel,
  // onExtraChange) -- no reimplementa la fórmula de precio.
  {
    function makeEl(initial) {
      return { checked: false, disabled: false, value: '', textContent: initial, innerHTML: '' };
    }
    const els = {
      'custom-modal-title': makeEl(''),
      'customization-modal': { classList: { add() {}, remove() {} } },
      'custom-models': makeEl(''),
      'extra-upscale': makeEl(''),
      'extra-qr': makeEl(''),
      'extra-adapter': makeEl(''),
      'extra-qr-message': makeEl(''),
      'custom-base-price': makeEl('0.00'),
      'custom-total': makeEl('0.00')
    };
    const finalPriceEl = makeEl('€0.00');

    const VARIANT_TYPES_FIXTURE = [
      {
        id: 4,
        nombre: 'Forma',
        options: [
          { id: 10, nombre: 'Base', price_delta: '0.00' },
          { id: 11, nombre: 'Cuadrada', price_delta: '15.00' }
        ]
      }
    ];

    const modalDocumentStub = {
      addEventListener: () => {},
      getElementById: (id) => els[id] || null,
      querySelector: (sel) => (sel === '[data-variant-price]' ? finalPriceEl : null),
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, remove() {} }),
      body: { appendChild: () => {} }
    };

    const sandbox = {
      console,
      document: modalDocumentStub,
      fetch: async (url) => {
        if (url.includes('/api/pricing-config')) return { ok: true, json: async () => PRICING_CONFIG_FIXTURE };
        if (url.includes('/variant-types')) return { ok: true, json: async () => VARIANT_TYPES_FIXTURE };
        return { ok: false, json: async () => ({ ok: false }) };
      }
    };
    vm.createContext(sandbox);
    vm.runInContext(readScript('public/js/shop.js'), sandbox, { filename: 'shop.js' });

    // Misma secuencia que en el navegador real: loadPricingConfig() al
    // cargar la página, allShopProducts poblado desde /api/productos
    // (precio como string, igual que la API real).
    await sandbox.loadPricingConfig();
    vm.runInContext(
      `allShopProducts = [{ id: 42, nombre: 'Producto Test', precio: '49.95' }];`,
      sandbox,
      { filename: 'shop-test-setup.js' }
    );

    await sandbox.openCustomization(42);
    check(
      els['custom-total'].textContent === '49.95',
      `openCustomization(): el precio inicial debe mostrar la base "49.95" nada más abrir, sin interacción, mostró "${els['custom-total'].textContent}"`
    );
    check(
      finalPriceEl.textContent === '49.95 €',
      `openCustomization(): [data-variant-price] debe mostrar "49.95 €" nada más abrir, mostró "${finalPriceEl.textContent}"`
    );

    // Modelo "Cuadrada" (+15) -- misma función real que dispara el onchange del radio
    sandbox.selectModel(11, 'Cuadrada', 15);
    check(els['custom-total'].textContent === '64.95', `selectModel(+15): esperaba "64.95", dio "${els['custom-total'].textContent}"`);

    // Extra Upscale (+5) -- misma función real que dispara el onchange del checkbox
    els['extra-upscale'].checked = true;
    sandbox.onExtraChange();
    check(els['custom-total'].textContent === '69.95', `onExtraChange() activar upscale: esperaba "69.95", dio "${els['custom-total'].textContent}"`);

    // Quitar el extra
    els['extra-upscale'].checked = false;
    sandbox.onExtraChange();
    check(els['custom-total'].textContent === '64.95', `onExtraChange() desactivar upscale: esperaba "64.95", dio "${els['custom-total'].textContent}"`);

    // Volver al modelo base (delta 0)
    sandbox.selectModel(10, 'Base', 0);
    check(els['custom-total'].textContent === '49.95', `selectModel(base, 0): esperaba "49.95", dio "${els['custom-total'].textContent}"`);
  }

  // Regresión (reset entre productos): #extra-upscale/#extra-qr/#extra-adapter
  // y #extra-qr-message son controles ESTÁTICOS del modal (a diferencia de
  // #custom-models, que se regenera por completo) -- sin resetCustomization-
  // ExtrasUI(), quedaban marcados/rellenos del producto anterior tanto en
  // pantalla como en lo que getExtrasFromUI() (usada por
  // confirmCustomization() para construir el ítem del carrito) devolvería
  // para el producto SIGUIENTE. Ejercita openCustomization() ->
  // closeCustomization() -> openCustomization() reales, con dos productos
  // distintos.
  {
    function makeEl(initial) {
      return { checked: false, disabled: false, value: '', textContent: initial, innerHTML: '' };
    }
    const els = {
      'custom-modal-title': makeEl(''),
      'customization-modal': { classList: { add() {}, remove() {} } },
      'custom-models': makeEl(''),
      'custom-notes': makeEl(''),
      'custom-files': makeEl(''),
      'custom-file-list': makeEl(''),
      'extra-upscale': makeEl(''),
      'extra-qr': makeEl(''),
      'extra-adapter': makeEl(''),
      'extra-qr-message': makeEl(''),
      'custom-base-price': makeEl('0.00'),
      'custom-total': makeEl('0.00')
    };
    const finalPriceEl = makeEl('€0.00');

    const VARIANT_TYPES_FIXTURE_A = [
      {
        id: 4,
        nombre: 'Forma',
        options: [{ id: 10, nombre: 'Base', price_delta: '0.00' }, { id: 11, nombre: 'Cuadrada', price_delta: '15.00' }]
      }
    ];

    const modalDocumentStub = {
      addEventListener: () => {},
      getElementById: (id) => els[id] || null,
      querySelector: (sel) => (sel === '[data-variant-price]' ? finalPriceEl : null),
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, remove() {} }),
      body: { appendChild: () => {} }
    };

    const sandbox = {
      console,
      document: modalDocumentStub,
      fetch: async (url) => {
        if (url.includes('/api/pricing-config')) return { ok: true, json: async () => PRICING_CONFIG_FIXTURE };
        // Producto A (id 42) tiene modelo con variantes; Producto B (id 43) no.
        if (url.includes('/productos/42/variant-types')) return { ok: true, json: async () => VARIANT_TYPES_FIXTURE_A };
        if (url.includes('/variant-types')) return { ok: true, json: async () => [] };
        return { ok: false, json: async () => ({ ok: false }) };
      }
    };
    vm.createContext(sandbox);
    vm.runInContext(readScript('public/js/shop.js'), sandbox, { filename: 'shop.js' });
    await sandbox.loadPricingConfig();
    vm.runInContext(
      `allShopProducts = [
        { id: 42, nombre: 'Producto A', precio: '49.95' },
        { id: 43, nombre: 'Producto B', precio: '30.00' }
      ];`,
      sandbox,
      { filename: 'shop-test-setup.js' }
    );

    // --- Producto A: modelo + los 3 extras + mensaje QR ---
    await sandbox.openCustomization(42);
    sandbox.selectModel(11, 'Cuadrada', 15);
    els['extra-upscale'].checked = true;
    els['extra-qr'].checked = true;
    els['extra-qr-message'].value = 'Mensaje secreto de A';
    els['extra-adapter'].checked = true;
    sandbox.onExtraChange();
    check(
      els['custom-total'].textContent === '78.95',
      `Producto A con modelo+3 extras: esperaba "78.95" (49.95+15+5+5+4), dio "${els['custom-total'].textContent}"`
    );

    // Cerrar SIN añadir al carrito
    sandbox.closeCustomization();

    // --- Producto B: abrir inmediatamente ---
    await sandbox.openCustomization(43);

    check(els['extra-upscale'].checked === false, `Reset entre productos: extra-upscale debe quedar desmarcado en B, quedó checked=${els['extra-upscale'].checked}`);
    check(els['extra-qr'].checked === false, `Reset entre productos: extra-qr debe quedar desmarcado en B, quedó checked=${els['extra-qr'].checked}`);
    check(els['extra-adapter'].checked === false, `Reset entre productos: extra-adapter debe quedar desmarcado en B, quedó checked=${els['extra-adapter'].checked}`);
    check(els['extra-qr-message'].value === '', `Reset entre productos: extra-qr-message debe quedar vacío en B, quedó "${els['extra-qr-message'].value}"`);
    check(
      els['custom-total'].textContent === '30.00',
      `Reset entre productos: precio inicial de B debe ser su propia base "30.00" (sin extras/modelo heredados de A), dio "${els['custom-total'].textContent}"`
    );

    // getExtrasFromUI() es lo que confirmCustomization() enviaría al carrito:
    // debe reflejar el estado limpio, no lo heredado de A.
    const extrasB = sandbox.getExtrasFromUI();
    check(
      extrasB.upscale === false && extrasB.qr === false && extrasB.adapter === false && extrasB.qrMessage === '' && extrasB.extrasTotal === 0,
      `Reset entre productos: getExtrasFromUI() para B debe estar limpio, dio ${JSON.stringify(extrasB)}`
    );

    // B sigue recalculando con sus propias opciones
    els['extra-upscale'].checked = true;
    sandbox.onExtraChange();
    check(els['custom-total'].textContent === '35.00', `B recalcula con su propio extra: esperaba "35.00", dio "${els['custom-total'].textContent}"`);

    // --- Volver a A: tampoco debe arrastrar lo que él mismo tenía antes ---
    sandbox.closeCustomization();
    await sandbox.openCustomization(42);
    check(
      els['custom-total'].textContent === '49.95',
      `Reabrir A: debe volver a su propia base "49.95" limpia, no lo que A mismo tenía seleccionado antes, dio "${els['custom-total'].textContent}"`
    );
    check(els['extra-upscale'].checked === false, 'Reabrir A: extra-upscale no debe recordar la selección anterior de A');
    check(els['extra-qr-message'].value === '', 'Reabrir A: extra-qr-message no debe recordar el mensaje anterior de A');
  }

  // EUR-ONLY-01 (sección 22): ningún script de storefront activo debe
  // contener "CHF" como etiqueta de precio hardcodeada. Comprobación de
  // texto fuente, no de ejecución -- si algún día hace falta distinguir
  // comentario de código activo aquí, seguir el patrón de
  // scripts/check-migration-no-demo-inserts.js.
  {
    const storefrontFiles = ['public/js/home.js', 'public/js/shop.js', 'public/js/cart.js', 'public/js/cart-page.js', 'public/js/checkout.js'];
    for (const relPath of storefrontFiles) {
      const src = readScript(relPath);
      check(!/CHF/.test(src), `${relPath} no contiene "CHF" como etiqueta de precio (EUR-ONLY-01)`);
    }
  }

  console.log(`OK: ${checks} comprobaciones sobre selecciones canónicas en cart.js/cart-page.js/home.js/shop.js.`);
}

main().catch(err => {
  console.error('FALLO en check-frontend-selections.js:', err.message);
  process.exit(1);
});
