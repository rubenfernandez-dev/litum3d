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

// customization.js (public/js/customization.js) es la fuente única de la
// lógica del modal de personalización, compartida entre /shop y Home -- se
// carga SIEMPRE antes de shop.js/home.js, igual que en las vistas reales
// (ver <script> en views/shop.html y views/index.html).
function loadHomeSandbox() {
  const sandbox = { console, document: makeDocumentStub(), fetch: makeFetchStub({ ok: false }), AbortController };
  vm.createContext(sandbox);
  vm.runInContext(readScript('public/js/customization.js'), sandbox, { filename: 'customization.js' });
  vm.runInContext(readScript('public/js/home.js'), sandbox, { filename: 'home.js' });
  return sandbox;
}

function loadShopSandbox() {
  const sandbox = { console, document: makeDocumentStub(), fetch: makeFetchStub({ ok: false }), AbortController };
  vm.createContext(sandbox);
  vm.runInContext(readScript('public/js/customization.js'), sandbox, { filename: 'customization.js' });
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

  // ================= arquitectura compartida (refactor(customization)) =================
  // Antes de este refactor, home.js tenía su PROPIA implementación completa
  // del modal (customizationState/pricingConfig duplicados, su propio
  // openCustomization/closeCustomization/updateCustomTotal, y un sistema de
  // "modelo" distinto basado en /api/productos/:id/modelos +
  // /calculate-variant-price, en vez del enfoque de shop.js basado en
  // variant-types). Esa implementación ya no existe: Home usa exactamente
  // public/js/customization.js, la misma lógica que /shop. Estas
  // comprobaciones verifican que la duplicación no ha vuelto.
  {
    const shopSrc = readScript('public/js/shop.js');
    const homeSrc = readScript('public/js/home.js');
    for (const [label, src] of [['shop.js', shopSrc], ['home.js', homeSrc]]) {
      check(!/let\s+customizationState/.test(src), `${label} ya no declara su propio customizationState (vive en customization.js)`);
      check(!/let\s+pricingConfig/.test(src), `${label} ya no declara su propio pricingConfig (vive en customization.js)`);
      check(!/function\s+openCustomization/.test(src), `${label} ya no declara su propio openCustomization (vive en customization.js)`);
      check(!/function\s+updateCustomizationPrice|function\s+updateCustomTotal/.test(src), `${label} ya no declara su propio cálculo de precio del modal (vive en customization.js)`);
      check(!/function\s+confirmCustomization/.test(src), `${label} ya no declara su propio confirmCustomization (vive en customization.js)`);
    }
    // El sistema de "modelo" legacy de home.js (product_models reales vía
    // /modelos + /calculate-variant-price) queda completamente retirado:
    // Home usa ahora el mismo enfoque que shop.js (variant-types).
    check(!/computeCustomizationPriceDelta|getSelectedVariantOptionIds|\/calculate-variant-price|\/modelos/.test(homeSrc), 'home.js ya no contiene el sistema de "modelo" legacy (product_models/calculate-variant-price), sustituido por el de customization.js (variant-types)');
  }

  // customization.js: sin fallback hardcodeado 5/5/4; consume /api/pricing-config
  {
    const src = readScript('public/js/customization.js');
    check(
      !/extrasCost \+= 5/.test(src) && !/extrasCost \+= 4/.test(src) && !/\(upscale \? 5/.test(src) && !/\(adapter \? 4/.test(src),
      'customization.js no contiene las constantes económicas hardcodeadas 5/5/4 como fuente de cálculo'
    );
    check(/\/api\/pricing-config/.test(src), 'customization.js consume /api/pricing-config');

    const shop = loadShopSandbox();
    shop.fetch = makeFetchStub(PRICING_CONFIG_FIXTURE);
    await shop.loadPricingConfig();
    check(shop.getExtraPrice('adapter') === 4, 'customization.js: getExtraPrice lee desde pricingConfig tras loadPricingConfig() (probado vía el sandbox de shop)');

    const home = loadHomeSandbox();
    home.fetch = makeFetchStub(PRICING_CONFIG_FIXTURE);
    await home.loadPricingConfig();
    check(home.getExtraPrice('adapter') === 4, 'customization.js: getExtraPrice funciona igual vía el sandbox de home (misma función, mismo resultado)');
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

    const sandbox = { console, document: modalDocumentStub, fetch: makeFetchStub(PRICING_CONFIG_FIXTURE), AbortController };
    vm.createContext(sandbox);
    vm.runInContext(readScript('public/js/customization.js'), sandbox, { filename: 'customization.js' });
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
      AbortController,
      fetch: async (url) => {
        if (url.includes('/api/pricing-config')) return { ok: true, json: async () => PRICING_CONFIG_FIXTURE };
        if (url.includes('/variant-types')) return { ok: true, json: async () => VARIANT_TYPES_FIXTURE };
        return { ok: false, json: async () => ({ ok: false }) };
      }
    };
    vm.createContext(sandbox);
    vm.runInContext(readScript('public/js/customization.js'), sandbox, { filename: 'customization.js' });
    vm.runInContext(readScript('public/js/shop.js'), sandbox, { filename: 'shop.js' });

    // Misma secuencia que en el navegador real: loadPricingConfig() al
    // cargar la página, lista de productos poblada desde /api/productos
    // (precio como string, igual que la API real) vía setCustomizationProducts().
    await sandbox.loadPricingConfig();
    sandbox.setCustomizationProducts([{ id: 42, nombre: 'Producto Test', precio: '49.95' }]);

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
      AbortController,
      fetch: async (url) => {
        if (url.includes('/api/pricing-config')) return { ok: true, json: async () => PRICING_CONFIG_FIXTURE };
        // Producto A (id 42) tiene modelo con variantes; Producto B (id 43) no.
        if (url.includes('/productos/42/variant-types')) return { ok: true, json: async () => VARIANT_TYPES_FIXTURE_A };
        if (url.includes('/variant-types')) return { ok: true, json: async () => [] };
        return { ok: false, json: async () => ({ ok: false }) };
      }
    };
    vm.createContext(sandbox);
    vm.runInContext(readScript('public/js/customization.js'), sandbox, { filename: 'customization.js' });
    vm.runInContext(readScript('public/js/shop.js'), sandbox, { filename: 'shop.js' });
    await sandbox.loadPricingConfig();
    sandbox.setCustomizationProducts([
      { id: 42, nombre: 'Producto A', precio: '49.95' },
      { id: 43, nombre: 'Producto B', precio: '30.00' }
    ]);

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

  // ================= Home (Destacados) usa la misma secuencia que Shop =================
  // Mismo escenario que el bloque "precio inicial al abrir el modal" de
  // arriba, pero cargando customization.js + home.js (en vez de shop.js) y
  // poblando la lista de productos como lo haría loadFeaturedProducts(),
  // para demostrar que Home ejecuta exactamente la misma función real, no
  // una reimplementación con el mismo resultado por casualidad.
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

    const VARIANT_TYPES_FIXTURE = [
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
      AbortController,
      fetch: async (url) => {
        if (url.includes('/api/pricing-config')) return { ok: true, json: async () => PRICING_CONFIG_FIXTURE };
        if (url.includes('/variant-types')) return { ok: true, json: async () => VARIANT_TYPES_FIXTURE };
        return { ok: false, json: async () => ({ ok: false }) };
      }
    };
    vm.createContext(sandbox);
    vm.runInContext(readScript('public/js/customization.js'), sandbox, { filename: 'customization.js' });
    vm.runInContext(readScript('public/js/home.js'), sandbox, { filename: 'home.js' });
    await sandbox.loadPricingConfig();
    // Como haría loadFeaturedProducts() con la respuesta de /api/productos.
    sandbox.setCustomizationProducts([{ id: 42, nombre: 'Producto Test', precio: '49.95' }]);

    await sandbox.openCustomization(42);
    check(els['custom-total'].textContent === '49.95', `Home: precio inicial al abrir debe ser "49.95", dio "${els['custom-total'].textContent}"`);
    check(finalPriceEl.textContent === '49.95 €', `Home: [data-variant-price] inicial debe ser "49.95 €", dio "${finalPriceEl.textContent}"`);

    sandbox.selectModel(11, 'Cuadrada', 15);
    check(els['custom-total'].textContent === '64.95', `Home: selectModel(+15) esperaba "64.95", dio "${els['custom-total'].textContent}"`);

    els['extra-upscale'].checked = true;
    sandbox.onExtraChange();
    check(els['custom-total'].textContent === '69.95', `Home: onExtraChange() activar upscale esperaba "69.95", dio "${els['custom-total'].textContent}"`);

    els['extra-upscale'].checked = false;
    sandbox.onExtraChange();
    check(els['custom-total'].textContent === '64.95', `Home: onExtraChange() desactivar upscale esperaba "64.95", dio "${els['custom-total'].textContent}"`);

    sandbox.selectModel(10, 'Base', 0);
    check(els['custom-total'].textContent === '49.95', `Home: volver a modelo base esperaba "49.95", dio "${els['custom-total'].textContent}"`);

    // Reset: abrir un segundo producto tras dejar extras marcados en el primero.
    sandbox.setCustomizationProducts([
      { id: 42, nombre: 'Producto A', precio: '49.95' },
      { id: 43, nombre: 'Producto B', precio: '30.00' }
    ]);
    els['extra-upscale'].checked = true;
    sandbox.onExtraChange();
    sandbox.closeCustomization();
    await sandbox.openCustomization(43);
    check(els['extra-upscale'].checked === false, 'Home: reset entre productos -- extra-upscale debe quedar desmarcado al abrir B');
    check(els['custom-total'].textContent === '30.00', `Home: reset entre productos -- precio inicial de B debe ser su propia base "30.00", dio "${els['custom-total'].textContent}"`);
  }

  // ================= Paridad Home vs Shop =================
  // Para la MISMA selección (mismo producto, modelo y extras), Home y Shop
  // deben producir exactamente el mismo precio mostrado y el mismo objeto
  // de extras que confirmCustomization() enviaría al carrito. Dos sandboxes
  // independientes (uno con shop.js, otro con home.js) sobre el mismo
  // customization.js real.
  {
    function makeParitySandbox(pageScript, pageScriptName) {
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
        AbortController,
        fetch: async (url) => {
          if (url.includes('/api/pricing-config')) return { ok: true, json: async () => PRICING_CONFIG_FIXTURE };
          if (url.includes('/variant-types')) return { ok: true, json: async () => VARIANT_TYPES_FIXTURE };
          return { ok: false, json: async () => ({ ok: false }) };
        }
      };
      vm.createContext(sandbox);
      vm.runInContext(readScript('public/js/customization.js'), sandbox, { filename: 'customization.js' });
      vm.runInContext(readScript(pageScript), sandbox, { filename: pageScriptName });
      return { sandbox, els, finalPriceEl };
    }

    const shopCtx = makeParitySandbox('public/js/shop.js', 'shop.js');
    const homeCtx = makeParitySandbox('public/js/home.js', 'home.js');

    for (const ctx of [shopCtx, homeCtx]) {
      await ctx.sandbox.loadPricingConfig();
      ctx.sandbox.setCustomizationProducts([{ id: 42, nombre: 'Producto Paridad', precio: '49.95' }]);
      await ctx.sandbox.openCustomization(42);
      ctx.sandbox.selectModel(11, 'Cuadrada', 15);
      ctx.els['extra-upscale'].checked = true;
      ctx.els['extra-qr'].checked = true;
      ctx.els['extra-qr-message'].value = 'Mismo mensaje';
      ctx.sandbox.onExtraChange();
    }

    check(
      shopCtx.els['custom-total'].textContent === homeCtx.els['custom-total'].textContent,
      `Paridad: precio mostrado Shop (${shopCtx.els['custom-total'].textContent}) === Home (${homeCtx.els['custom-total'].textContent})`
    );
    check(
      shopCtx.finalPriceEl.textContent === homeCtx.finalPriceEl.textContent,
      `Paridad: [data-variant-price] Shop (${shopCtx.finalPriceEl.textContent}) === Home (${homeCtx.finalPriceEl.textContent})`
    );

    const shopExtras = shopCtx.sandbox.getExtrasFromUI();
    const homeExtras = homeCtx.sandbox.getExtrasFromUI();
    check(
      JSON.stringify(shopExtras) === JSON.stringify(homeExtras),
      `Paridad: getExtrasFromUI() (lo que confirmCustomization() enviaría al carrito) Shop === Home. Shop=${JSON.stringify(shopExtras)} Home=${JSON.stringify(homeExtras)}`
    );
    check(
      shopCtx.sandbox.getVariantsPriceDelta() === homeCtx.sandbox.getVariantsPriceDelta(),
      'Paridad: getVariantsPriceDelta() Shop === Home'
    );
  }

  // ================= Obligatoriedad de modelo depende de la configuración real, no del producto =================
  // Antes de esta reparación, confirmCustomization() solo comprobaba
  // `!customizationState.selectedModelId`, que no distingue "el producto no
  // tiene modelos" de "tiene modelos y el usuario no eligió ninguno" --
  // bloqueaba SIEMPRE que no hubiera selección, incluso en productos sin
  // ningún modelo configurado en Admin. Este bloque ejercita el MISMO
  // product_id (99) cambiando lo que devuelve /variant-types entre llamadas
  // (0 -> 2 -> 0 modelos), simulando que Admin reconfigura el producto sin
  // ningún despliegue de frontend -- demuestra que la regla depende de la
  // configuración real, no de una lista/ID hardcodeado.
  {
    function makeEl(initial) {
      return { checked: false, disabled: false, value: '', textContent: initial, innerHTML: '', style: {} };
    }

    function buildModalSandbox(pageScript, pageScriptName) {
      const els = {
        'custom-modal-title': makeEl(''),
        'customization-modal': { classList: { add() {}, remove() {} } },
        'custom-models': makeEl(''),
        'custom-models-section': makeEl(''),
        'custom-notes': makeEl(''),
        'custom-files': makeEl(''),
        'custom-file-list': makeEl(''),
        'extra-upscale': makeEl(''),
        'extra-qr': makeEl(''),
        'extra-qr-message': makeEl(''),
        'extra-adapter': makeEl(''),
        'custom-base-price': makeEl('0.00'),
        'custom-total': makeEl('0.00')
      };
      const finalPriceEl = makeEl('€0.00');
      const alerts = [];

      const modalDocumentStub = {
        addEventListener: () => {},
        getElementById: (id) => els[id] || null,
        querySelector: (sel) => (sel === '[data-variant-price]' ? finalPriceEl : null),
        querySelectorAll: () => [],
        createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, remove() {} }),
        body: { appendChild: () => {} }
      };

      // Fixture mutable de /variant-types para el producto 99: cambia entre
      // llamadas para simular una reconfiguración real hecha desde Admin.
      let variantTypesFixture = [];
      const sandbox = {
        console,
        document: modalDocumentStub,
        alert: (msg) => alerts.push(msg),
        FormData,
        AbortController,
        setTimeout: () => {},
        localStorage: makeLocalStorageStub(),
        fetch: async (url) => {
          if (url.includes('/api/pricing-config')) return { ok: true, json: async () => PRICING_CONFIG_FIXTURE };
          if (url.includes('/variant-types')) return { ok: true, json: async () => variantTypesFixture };
          if (url.includes('/api/uploads/custom')) return { ok: true, json: async () => ({ files: [] }) };
          return { ok: false, json: async () => ({ ok: false }) };
        }
      };
      vm.createContext(sandbox);
      vm.runInContext(readScript('public/js/cart.js'), sandbox, { filename: 'cart.js' });
      vm.runInContext(readScript('public/js/customization.js'), sandbox, { filename: 'customization.js' });
      vm.runInContext(readScript(pageScript), sandbox, { filename: pageScriptName });

      return {
        sandbox,
        els,
        alerts,
        setVariantTypes: (fixture) => { variantTypesFixture = fixture; },
        getState: () => vm.runInContext('customizationState', sandbox, { filename: 'read-state.js' }),
        setFiles: () => vm.runInContext("customizationState.files = [{name:'foto.jpg'}];", sandbox, { filename: 'set-files.js' })
      };
    }

    const MODEL_OPTIONS_FIXTURE = [
      {
        id: 4,
        nombre: 'Forma',
        options: [
          { id: 20, nombre: 'Redonda', price_delta: '10.00' },
          { id: 21, nombre: 'Cuadrada', price_delta: '15.00' }
        ]
      }
    ];

    // --- Secuencia completa (Estado 1 -> 2 -> 3) sobre /shop ---
    const ctx = buildModalSandbox('public/js/shop.js', 'shop.js');
    ctx.sandbox.setCustomizationProducts([{ id: 99, nombre: 'Producto Dinámico', precio: '30.00' }]);

    // Estado 1: el producto 99 no tiene modelos configurados todavía.
    ctx.setVariantTypes([]);
    await ctx.sandbox.openCustomization(99);
    check(ctx.getState().hasSelectableModels === false, 'Estado 1 (0 modelos): hasSelectableModels=false');
    check(ctx.getState().modelsLoaded === true, 'Estado 1: modelsLoaded=true tras completar la carga');
    check(ctx.els['custom-models-section'].style.display === 'none', 'Estado 1: la sección Modelo se oculta cuando el producto no tiene modelos');

    ctx.setFiles();
    await ctx.sandbox.confirmCustomization();
    check(ctx.alerts.length === 0, `Estado 1: confirmCustomization no debe bloquear un producto sin modelos; alerts=${JSON.stringify(ctx.alerts)}`);
    let cart = ctx.sandbox.getCart();
    check(cart.length === 1, 'Estado 1: el producto se añade al carrito sin exigir modelo');
    check(cart[0].modelId === null, 'Estado 1: modelId=null en el carrito cuando el producto no tiene modelos');
    check(cart[0].priceDelta === 0, 'Estado 1: priceDelta=0 cuando el producto no tiene modelos');

    // Estado 2: Admin añade 2 modelos al MISMO producto 99 (mismo product_id,
    // ningún cambio de código ni redeploy de frontend).
    ctx.setVariantTypes(MODEL_OPTIONS_FIXTURE);
    await ctx.sandbox.openCustomization(99);
    check(ctx.getState().hasSelectableModels === true, 'Estado 2 (2 modelos): hasSelectableModels=true para el MISMO product_id que en el Estado 1 no los tenía');
    check(ctx.els['custom-models-section'].style.display === '', 'Estado 2: la sección Modelo se muestra cuando el producto pasa a tener modelos');

    ctx.setFiles();
    await ctx.sandbox.confirmCustomization();
    check(ctx.alerts.length === 1 && /modelo/i.test(ctx.alerts[0]), `Estado 2: sin seleccionar modelo, confirmCustomization debe bloquear (mismo producto que en el Estado 1 no lo exigía); alerts=${JSON.stringify(ctx.alerts)}`);
    check(ctx.sandbox.getCart().length === 1, 'Estado 2: el bloqueo por falta de selección no debe añadir nada al carrito');

    ctx.alerts.length = 0;
    ctx.sandbox.selectModel(21, 'Cuadrada', 15);
    ctx.setFiles();
    await ctx.sandbox.confirmCustomization();
    check(ctx.alerts.length === 0, `Estado 2: con modelo seleccionado, confirmCustomization debe proceder; alerts=${JSON.stringify(ctx.alerts)}`);
    cart = ctx.sandbox.getCart();
    check(cart.length === 2, 'Estado 2: la personalización con modelo se añade como línea nueva (no se fusiona con la línea sin modelo)');
    check(cart[1].variantOptionIds.includes(21), 'Estado 2: el modelo elegido viaja en variantOptionIds (21)');
    check(cart[1].modelName === 'Cuadrada', 'Estado 2: modelName conserva la etiqueta de presentación del modelo elegido');
    check(cart[1].priceDelta === 15, 'Estado 2: priceDelta refleja el price_delta del modelo elegido (15)');

    // Estado 3: Admin elimina de nuevo todos los modelos del MISMO producto 99.
    ctx.setVariantTypes([]);
    await ctx.sandbox.openCustomization(99);
    check(ctx.getState().hasSelectableModels === false, 'Estado 3 (vuelve a 0 modelos): hasSelectableModels=false para el MISMO product_id');
    check(ctx.getState().selectedModelId === null, 'Estado 3: la selección de modelo del Estado 2 no se conserva al reabrir');
    check(ctx.els['custom-models-section'].style.display === 'none', 'Estado 3: la sección Modelo vuelve a ocultarse');

    ctx.setFiles();
    await ctx.sandbox.confirmCustomization();
    check(ctx.alerts.length === 0, `Estado 3: confirmCustomization vuelve a permitir continuar sin modelo para el mismo producto que en el Estado 2 lo exigía; alerts=${JSON.stringify(ctx.alerts)}`);
    cart = ctx.sandbox.getCart();
    // La nueva línea sin personalización se fusiona con la del Estado 1 (id
    // 99, también sin modelo/variantes/extras) -- mismo comportamiento de
    // fusión que cualquier producto sin personalización (ver hasNoPersonalization
    // en cart.js), no un caso especial de esta reparación.
    check(cart.length === 2, 'Estado 3: se fusiona con la línea sin personalización del Estado 1 (mismo producto, sin modelo en ambos casos)');
    check(cart[0].quantity === 2, 'Estado 3: la fusión incrementa la cantidad de la línea sin modelo');
    check(cart[0].modelId === null && cart[0].priceDelta === 0, 'Estado 3: modelId=null y priceDelta=0, igual que en el Estado 1, para el mismo producto');

    // --- Home usa exactamente la misma regla (fuente única: customization.js) ---
    const homeCtx = buildModalSandbox('public/js/home.js', 'home.js');
    homeCtx.sandbox.setCustomizationProducts([{ id: 99, nombre: 'Producto Dinámico', precio: '30.00' }]);

    homeCtx.setVariantTypes([]);
    await homeCtx.sandbox.openCustomization(99);
    homeCtx.setFiles();
    await homeCtx.sandbox.confirmCustomization();
    check(homeCtx.alerts.length === 0, 'Home, 0 modelos: confirmCustomization no bloquea (misma regla que Shop)');

    homeCtx.setVariantTypes(MODEL_OPTIONS_FIXTURE);
    await homeCtx.sandbox.openCustomization(99);
    homeCtx.setFiles();
    await homeCtx.sandbox.confirmCustomization();
    check(homeCtx.alerts.length === 1 && /modelo/i.test(homeCtx.alerts[0]), 'Home, 2 modelos sin seleccionar: confirmCustomization bloquea (misma regla que Shop)');

    homeCtx.alerts.length = 0;
    homeCtx.sandbox.selectModel(20, 'Redonda', 10);
    homeCtx.setFiles();
    await homeCtx.sandbox.confirmCustomization();
    check(homeCtx.alerts.length === 0, 'Home, 2 modelos con selección: confirmCustomization procede (misma regla que Shop)');

    // Asincronía (sección 7): confirmCustomization no puede decidir nada
    // mientras loadModelsForProduct() está en curso -- se bloquea igual que
    // ante una respuesta todavía desconocida, en vez de asumir "sin modelos".
    {
      const raceCtx = buildModalSandbox('public/js/shop.js', 'shop.js');
      raceCtx.sandbox.setCustomizationProducts([{ id: 100, nombre: 'Producto Lento', precio: '20.00' }]);
      // loadModelsForProduct() ahora espera (await) también a loadVariantTypes(),
      // que consulta el MISMO endpoint /variant-types una segunda vez de forma
      // secuencial (ver informe de la carrera): solo la PRIMERA llamada se deja
      // pendiente aquí -- es la que basta para demostrar "todavía no se sabe
      // si hay modelos"; la segunda se resuelve enseguida para no bloquear el
      // test en una promesa que nunca se resolvería.
      let resolveVariantTypes;
      let variantTypesCallCount = 0;
      raceCtx.sandbox.fetch = async (url) => {
        if (url.includes('/api/pricing-config')) return { ok: true, json: async () => PRICING_CONFIG_FIXTURE };
        if (url.includes('/variant-types')) {
          variantTypesCallCount++;
          if (variantTypesCallCount === 1) {
            await new Promise((resolve) => { resolveVariantTypes = resolve; });
          }
          return { ok: true, json: async () => [] };
        }
        return { ok: false, json: async () => ({ ok: false }) };
      };
      const openPromise = raceCtx.sandbox.openCustomization(100);
      check(raceCtx.getState().modelsLoaded === false, 'Carga en curso: modelsLoaded=false mientras /variant-types no ha respondido');
      raceCtx.setFiles();
      await raceCtx.sandbox.confirmCustomization();
      check(raceCtx.alerts.length === 1 && /espera|cargando/i.test(raceCtx.alerts[0]), `Carga en curso: confirmCustomization bloquea en vez de asumir "sin modelos"; alerts=${JSON.stringify(raceCtx.alerts)}`);
      check(raceCtx.sandbox.getCart().length === 0, 'Carga en curso: el bloqueo no debe haber añadido nada al carrito');
      resolveVariantTypes();
      await openPromise;
    }

    // Sin hardcode de IDs de producto para esta decisión (sección 5).
    {
      const src = readScript('public/js/customization.js');
      check(!/product(Id)?\s*===?\s*[67]\b/.test(src), 'customization.js no compara product.id/productId contra IDs concretos (p.ej. 6/7) para decidir sobre modelos');
      check(!/productsWithoutModels/i.test(src), 'customization.js no contiene una lista hardcodeada de productos sin modelos');
      check(/hasSelectableModels/.test(src), 'customization.js deriva la obligatoriedad de modelo de un estado explícito (hasSelectableModels), no de selectedModelId a secas');
    }
  }

  // ================= Carrera entre aperturas: respuestas obsoletas nunca deben mutar el estado/DOM actual =================
  // fix(customization): prevent stale variant loading races.
  //
  // Causa raíz (ver informe): cada apertura llamaba a
  // loadModelsForProduct()/loadVariantTypes() sin ninguna forma de saber si
  // seguía siendo la apertura vigente. Una respuesta que llegaba tarde --
  // porque el usuario ya había cerrado el modal, o abierto OTRO producto --
  // mutaba customizationState y el DOM (#custom-models, #custom-models-section,
  // el precio) igualmente, y openCustomization() volvía a mostrar el modal
  // (classList.add('show')) sin comprobar si esa apertura seguía vigente.
  // Estos tests reproducen exactamente esas dos secuencias con latencia
  // controlada por producto y demuestran que, tras el fix (AbortController
  // por apertura, comprobado con signal.aborted tras cada await), una
  // respuesta obsoleta queda sin efecto.
  {
    function makeEl(initial) {
      return { checked: false, disabled: false, value: '', textContent: initial, innerHTML: '', style: {} };
    }

    // fetch controlable con latencia INDEPENDIENTE por producto: las
    // llamadas a /variant-types de un producto quedan pendientes hasta que
    // el test llama a release(id) explícitamente -- momento en el que se
    // resuelven todas las que estén pendientes en ese instante Y las que
    // lleguen después (loadModelsForProduct ahora también espera a
    // loadVariantTypes(), que repite la misma llamada de forma secuencial).
    function makeControllableFetch(fixtures) {
      const released = new Set();
      const waiters = {};
      const urlLog = [];
      async function fetchImpl(url) {
        urlLog.push(url);
        if (url.includes('/api/pricing-config')) return { ok: true, json: async () => PRICING_CONFIG_FIXTURE };
        const m = url.match(/\/api\/productos\/(\d+)\/variant-types/);
        if (!m) return { ok: false, json: async () => ({ ok: false }) };
        const id = m[1];
        if (released.has(id)) {
          return { ok: true, json: async () => fixtures[id] || [] };
        }
        return new Promise((resolve) => {
          (waiters[id] = waiters[id] || []).push(resolve);
        });
      }
      function release(id) {
        id = String(id);
        released.add(id);
        const pendingForId = waiters[id] || [];
        waiters[id] = [];
        pendingForId.forEach((resolve) => resolve({ ok: true, json: async () => fixtures[id] || [] }));
      }
      return { fetchImpl, release, urlLog };
    }

    function buildRaceSandbox(fetchImpl) {
      const els = {
        'custom-modal-title': makeEl(''),
        'customization-modal': { classList: { add() {}, remove() {} } },
        'custom-models': makeEl(''),
        'custom-models-section': makeEl(''),
        'custom-notes': makeEl(''),
        'custom-files': makeEl(''),
        'custom-file-list': makeEl(''),
        'extra-upscale': makeEl(''),
        'extra-qr': makeEl(''),
        'extra-qr-message': makeEl(''),
        'extra-adapter': makeEl(''),
        'custom-base-price': makeEl('0.00'),
        'custom-total': makeEl('0.00')
      };
      const finalPriceEl = makeEl('€0.00');
      const modalDocumentStub = {
        addEventListener: () => {},
        getElementById: (id) => els[id] || null,
        querySelector: (sel) => (sel === '[data-variant-price]' ? finalPriceEl : null),
        querySelectorAll: () => [],
        createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, remove() {} }),
        body: { appendChild: () => {} }
      };
      const sandbox = { console, document: modalDocumentStub, fetch: fetchImpl, AbortController };
      vm.createContext(sandbox);
      vm.runInContext(readScript('public/js/customization.js'), sandbox, { filename: 'customization.js' });
      vm.runInContext(readScript('public/js/shop.js'), sandbox, { filename: 'shop.js' });
      return {
        sandbox,
        els,
        finalPriceEl,
        getState: () => vm.runInContext('customizationState', sandbox, { filename: 'read-state.js' })
      };
    }

    const MODEL_A_FIXTURE = [{ id: 4, nombre: 'Forma', options: [{ id: 16, nombre: 'cilindrica-de-A', price_delta: '0.00' }] }];

    // --- Test 1: A pendiente -> se abre B -> B responde primero -> A responde tarde (abandonada) ---
    {
      const { fetchImpl, release } = makeControllableFetch({ 1: MODEL_A_FIXTURE, 2: [] });
      const ctx = buildRaceSandbox(fetchImpl);
      ctx.sandbox.setCustomizationProducts([
        { id: 1, nombre: 'Producto A', precio: '49.95' },
        { id: 2, nombre: 'Producto B', precio: '30.00' }
      ]);

      const openA = ctx.sandbox.openCustomization(1); // fetch de A queda pendiente
      await Promise.resolve();

      const openB = ctx.sandbox.openCustomization(2); // sustituye a A como apertura vigente; fetch de B también pendiente
      await Promise.resolve();

      release('2'); // B responde primero
      await openB;

      check(ctx.getState().product?.id === 2, 'Estrés A->B: tras responder B, el producto activo debe ser B');
      check(ctx.getState().hasSelectableModels === false, 'Estrés A->B: hasSelectableModels debe reflejar la config de B (sin modelos), no la de A');
      check(ctx.els['custom-models'].innerHTML === '', 'Estrés A->B: #custom-models debe reflejar B (vacío), no contener nada de A');
      check(ctx.els['custom-total'].textContent === '30.00', 'Estrés A->B: el precio mostrado debe ser el de B (30.00)');

      release('1'); // AHORA llega tarde la respuesta abandonada de A
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      await openA.catch(() => {});

      // La respuesta tardía de A NO debe haber modificado nada de lo que el
      // usuario está viendo (que sigue siendo B): ni el estado ni el DOM.
      check(ctx.getState().product?.id === 2, 'Estrés A->B: tras la respuesta tardía de A, el producto activo sigue siendo B');
      check(ctx.getState().hasSelectableModels === false, 'Estrés A->B: la respuesta tardía de A no debe activar hasSelectableModels de B');
      check(ctx.els['custom-models'].innerHTML === '', `Estrés A->B: #custom-models NO debe contener el modelo de A ("cilindrica-de-A"); contenido actual: ${JSON.stringify(ctx.els['custom-models'].innerHTML)}`);
      check(ctx.els['custom-total'].textContent === '30.00', 'Estrés A->B: el precio debe seguir siendo el de B (30.00), no verse alterado por A');
      check(ctx.els['custom-modal-title'].textContent === 'Personalizar: Producto B', 'Estrés A->B: el título debe seguir siendo el de B');
    }

    // --- Test 2: A pendiente -> el usuario CIERRA antes de que responda -> llega la respuesta -> nada debe cambiar ---
    {
      const { fetchImpl, release } = makeControllableFetch({ 1: MODEL_A_FIXTURE });
      const ctx = buildRaceSandbox(fetchImpl);
      ctx.sandbox.setCustomizationProducts([{ id: 1, nombre: 'Producto A', precio: '49.95' }]);

      // classList.add('show') es la señal de "el modal se muestra": se
      // instrumenta para detectar si una respuesta tardía lo reabre solo.
      const showCalls = [];
      ctx.els['customization-modal'].classList.add = () => showCalls.push('add');
      ctx.els['customization-modal'].classList.remove = () => showCalls.push('remove');

      const openA = ctx.sandbox.openCustomization(1); // fetch de A queda pendiente
      await Promise.resolve();

      ctx.sandbox.closeCustomization(); // el usuario cierra ANTES de que A responda
      const stateAfterClose = ctx.getState();
      check(stateAfterClose.product === null, 'Cierre antes de respuesta: closeCustomization() deja product=null de inmediato');
      check(showCalls[showCalls.length - 1] === 'remove', 'Cierre antes de respuesta: el modal se oculta (classList.remove) al cerrar');

      release('1'); // llega la respuesta, tarde, para un modal ya cerrado
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      await openA.catch(() => {});

      check(!showCalls.includes('add'), `Cierre antes de respuesta: la respuesta tardía de A NUNCA debe reabrir el modal (classList.add('show')); llamadas registradas=${JSON.stringify(showCalls)}`);
      const stateAfterLateResponse = ctx.getState();
      check(stateAfterLateResponse.product === null, 'Cierre antes de respuesta: el estado sigue "cerrado" (product=null) tras la respuesta tardía');
      check(stateAfterLateResponse.hasSelectableModels === false, 'Cierre antes de respuesta: la respuesta tardía no debe filtrar hasSelectableModels al estado ya reseteado');
      check(ctx.els['custom-models'].innerHTML === '', 'Cierre antes de respuesta: #custom-models no debe rellenarse con el modelo de A tras el cierre');
    }
  }

  // ================= Consentimiento de fotos: unificado entre Home y Shop =================
  // fix(customization): require photo consent across home and shop.
  //
  // Antes, #photo-consent solo existía en views/index.html (Home/ES);
  // views/shop.html (y el resto de vistas) no lo incluían, así que la misma
  // personalización tenía una regla distinta según por dónde entrara el
  // usuario. Ahora #photo-consent existe en las 6 vistas (Home + Shop,
  // ES/DE/FR) con el mismo contrato DOM, y confirmCustomization() -- ÚNICA
  // fuente de validación, sin lógica añadida en home.js/shop.js -- sigue
  // siendo la misma comprobación condicional a que el elemento exista en el
  // DOM (no un flag nuevo, no una lista de páginas).
  {
    const src = readScript('public/js/customization.js');
    check(/getElementById\('photo-consent'\)/.test(src), 'customization.js comprueba #photo-consent antes de confirmar (si existe en la página)');
    check(/photoConsentCheckbox\.checked/.test(src) || /photo-consent.*checked|checked.*photo-consent/s.test(src), 'customization.js exige que #photo-consent esté marcado cuando existe');

    // Comprobación de fuente (sección 10): evita que #photo-consent
    // desaparezca de alguna vista sin que ningún test lo detecte -- lo que
    // pasó desapercibido en /shop hasta este fix. Sobre el HTML tal cual se
    // sirve, no sobre una copia reescrita.
    const CONSENT_VIEWS = ['index.html', 'index-de.html', 'index-fr.html', 'shop.html', 'shop-de.html', 'shop-fr.html'];
    for (const view of CONSENT_VIEWS) {
      const html = readScript(`views/${view}`);
      check(/id="photo-consent"/.test(html), `views/${view} debe incluir #photo-consent en el modal de personalización`);
    }
  }

  // Comportamiento real (bloquea/permite) y reset entre aperturas, ejecutado
  // con el código real de cart.js + customization.js + shop.js/home.js --
  // no una reimplementación de la regla.
  {
    function makeEl(initial) {
      return { checked: false, disabled: false, value: '', textContent: initial, innerHTML: '', style: {}, focus() {} };
    }

    function buildConsentSandbox(pageScript, pageScriptName) {
      const els = {
        'custom-modal-title': makeEl(''),
        'customization-modal': { classList: { add() {}, remove() {} } },
        'custom-models': makeEl(''),
        'custom-models-section': makeEl(''),
        'custom-notes': makeEl(''),
        'custom-files': makeEl(''),
        'custom-file-list': makeEl(''),
        'extra-upscale': makeEl(''),
        'extra-qr': makeEl(''),
        'extra-qr-message': makeEl(''),
        'extra-adapter': makeEl(''),
        'photo-consent': makeEl(''),
        'custom-base-price': makeEl('0.00'),
        'custom-total': makeEl('0.00')
      };
      const finalPriceEl = makeEl('€0.00');
      const alerts = [];
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
        alert: (msg) => alerts.push(msg),
        FormData,
        AbortController,
        setTimeout: () => {},
        localStorage: makeLocalStorageStub(),
        fetch: async (url) => {
          if (url.includes('/api/pricing-config')) return { ok: true, json: async () => PRICING_CONFIG_FIXTURE };
          if (url.includes('/variant-types')) return { ok: true, json: async () => [] }; // sin modelos: foco exclusivo en el consentimiento
          if (url.includes('/api/uploads/custom')) return { ok: true, json: async () => ({ files: [] }) };
          return { ok: false, json: async () => ({ ok: false }) };
        }
      };
      vm.createContext(sandbox);
      vm.runInContext(readScript('public/js/cart.js'), sandbox, { filename: 'cart.js' });
      vm.runInContext(readScript('public/js/customization.js'), sandbox, { filename: 'customization.js' });
      vm.runInContext(readScript(pageScript), sandbox, { filename: pageScriptName });
      return {
        sandbox,
        els,
        alerts,
        setFiles: () => vm.runInContext("customizationState.files = [{name:'foto.jpg'}];", sandbox, { filename: 'set-files.js' })
      };
    }

    for (const [pageScript, pageScriptName, label] of [
      ['public/js/shop.js', 'shop.js', 'Shop'],
      ['public/js/home.js', 'home.js', 'Home']
    ]) {
      const ctx = buildConsentSandbox(pageScript, pageScriptName);
      ctx.sandbox.setCustomizationProducts([
        { id: 201, nombre: 'Producto A', precio: '25.00' },
        { id: 202, nombre: 'Producto B', precio: '18.00' }
      ]);

      // --- Sin marcar: bloquea (con foto y sin restricción de modelo, para aislar el consentimiento) ---
      await ctx.sandbox.openCustomization(201);
      ctx.setFiles();
      await ctx.sandbox.confirmCustomization();
      check(ctx.alerts.length === 1 && /fotos/i.test(ctx.alerts[0]), `${label}: sin marcar #photo-consent, confirmCustomization() debe bloquear; alerts=${JSON.stringify(ctx.alerts)}`);
      check(ctx.sandbox.getCart().length === 0, `${label}: el bloqueo por falta de consentimiento no debe añadir nada al carrito`);

      // --- Marcando: permite ---
      ctx.alerts.length = 0;
      ctx.els['photo-consent'].checked = true;
      await ctx.sandbox.confirmCustomization();
      check(ctx.alerts.length === 0, `${label}: con #photo-consent marcado, confirmCustomization() debe proceder; alerts=${JSON.stringify(ctx.alerts)}`);
      check(ctx.sandbox.getCart().length === 1, `${label}: el producto debe añadirse al carrito tras aceptar el consentimiento`);

      // --- Reset (sección 6): A marca consentimiento y cierra SIN añadir; B no debe heredarlo ---
      await ctx.sandbox.openCustomization(201);
      ctx.els['photo-consent'].checked = true;
      ctx.sandbox.closeCustomization(); // cierre explícito, sin confirmar

      await ctx.sandbox.openCustomization(202);
      check(ctx.els['photo-consent'].checked === false, `${label}: abrir B tras marcar consentimiento en A (cerrado sin añadir) no debe heredarlo`);

      // --- Marcar en B, cerrar, reabrir A: debe volver a estar desmarcado ---
      ctx.els['photo-consent'].checked = true;
      ctx.sandbox.closeCustomization();
      await ctx.sandbox.openCustomization(201);
      check(ctx.els['photo-consent'].checked === false, `${label}: reabrir A tras marcar y cerrar B no debe heredar el consentimiento de B`);
    }
  }

  // EUR-ONLY-01 (sección 22): ningún script de storefront activo debe
  // contener "CHF" como etiqueta de precio hardcodeada. Comprobación de
  // texto fuente, no de ejecución -- si algún día hace falta distinguir
  // comentario de código activo aquí, seguir el patrón de
  // scripts/check-migration-no-demo-inserts.js.
  {
    const storefrontFiles = ['public/js/customization.js', 'public/js/home.js', 'public/js/shop.js', 'public/js/cart.js', 'public/js/cart-page.js', 'public/js/checkout.js'];
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
