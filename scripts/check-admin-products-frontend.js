/*
  LITUM3D - Test de regresión: flujo de creación de productos desde Admin
  (fix(admin): configure variants after product creation).

  Decisión de arquitectura vigente (sustituye a la de e4e00ff): crear un
  producto guarda SOLO sus datos propios; las variantes (Base/Forma vía
  product_variant_types/product_variant_options) se configuran DESPUÉS, en
  edición, con el "+ Añadir" que ya funciona. saveProduct() ya NO debe copiar
  ni asociar automáticamente ninguna variante durante la creación -- ese
  comportamiento (introducido en e4e00ff y ya retirado) es precisamente lo
  que este test debe detectar si alguna vez reaparece.

  Ejecuta el <script> inline de views/admin-products.html TAL CUAL se sirve
  al navegador, en un sandbox de Node (vm nativo) con DOM/fetch/adminFetch
  mínimos simulados -- mismo patrón que scripts/check-admin-currency-display.js
  para admin-dashboard.html y scripts/check-frontend-selections.js para
  public/js/*.js. No se reescribe ni se reimplementa saveProduct(): se prueba
  el código real.

  Uso: node scripts/check-admin-products-frontend.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function readAdminProductsScript() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin-products.html'), 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('No se encontró el <script> inline en views/admin-products.html');
  return match[1];
}

function readAdminProductsHtml() {
  return fs.readFileSync(path.join(__dirname, '..', 'views', 'admin-products.html'), 'utf8');
}

function makeElementStub() {
  const addCalls = [];
  const removeCalls = [];
  return {
    textContent: '', innerHTML: '', value: '', style: {}, dataset: {},
    classList: {
      add(c) { addCalls.push(c); },
      remove(c) { removeCalls.push(c); }
    },
    addEventListener() {},
    appendChild() {},
    reset() {},
    _classListCalls: { addCalls, removeCalls }
  };
}

// <select> real: value/innerHTML necesitan comportamiento propio
// (loadProductVariants reinicia el select reasignando innerHTML como string
// y luego añade <option> reales vía appendChild).
function makeSelectStub() {
  const state = { value: '', options: [] };
  const el = {
    style: {}, classList: { add() {}, remove() {} }, addEventListener() {},
    appendChild(opt) { state.options.push(opt); }
  };
  Object.defineProperty(el, 'value', {
    get: () => state.value,
    set: (v) => { state.value = v; }
  });
  Object.defineProperty(el, 'innerHTML', {
    get: () => '',
    set: () => { state.options = []; }
  });
  Object.defineProperty(el, 'selectedOptions', {
    get: () => state.options.filter((o) => String(o.value) === String(state.value))
  });
  return el;
}

function makeDocumentStub() {
  const registry = new Map();
  registry.set('variantBase', makeSelectStub());
  registry.set('variantShape', makeSelectStub());
  return {
    getElementById(id) {
      if (!registry.has(id)) registry.set(id, makeElementStub());
      return registry.get(id);
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
    createElement: (tag) => (tag === 'option' ? { value: '', textContent: '', dataset: {} } : makeElementStub()),
    _registry: registry
  };
}

function loadAdminProductsSandbox({ onFetch, onAdminFetch } = {}) {
  const document = makeDocumentStub();
  const alerts = [];
  const confirms = [];
  const sandbox = {
    console,
    document,
    window: { location: {} },
    alert: (msg) => alerts.push(msg),
    confirm: () => { confirms.push(true); return true; },
    fetch: onFetch || (async () => ({ ok: false, status: 401, json: async () => ({}) })),
    adminFetch: onAdminFetch || (async () => ({ ok: false, status: 401, json: async () => ({}) }))
  };
  vm.createContext(sandbox);
  vm.runInContext(readAdminProductsScript(), sandbox, { filename: 'admin-products.inline.js' });
  return { sandbox, document, alerts };
}

function setField(document, id, value) {
  document.getElementById(id).value = value;
}

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); checks++; }

async function main() {
  // ================= Creación: SOLO datos propios, sin copiar/asociar variantes =================
  {
    // Aleatorio en cada ejecución: el test no debe depender de -- ni el
    // código debe adivinar -- ningún ID fijo.
    const newProductId = 9000 + Math.floor(Math.random() * 90000);

    const adminFetchCalls = [];
    const fetchCalls = [];
    const { sandbox, document, alerts } = loadAdminProductsSandbox({
      onFetch: async (url) => {
        fetchCalls.push(url);
        if (url === `/api/productos/${newProductId}/variant-types`) return { ok: true, json: async () => [] };
        if (url === '/api/productos') return { ok: true, json: async () => [] };
        return { ok: false, json: async () => ({}) };
      },
      onAdminFetch: async (url, opts) => {
        const body = JSON.parse(opts.body);
        adminFetchCalls.push({ url, method: opts.method, body });
        if (url === '/api/productos') {
          return { ok: true, status: 201, json: async () => ({ id: newProductId, nombre: body.nombre, precio: body.precio }) };
        }
        return { ok: false, json: async () => ({ error: 'unexpected call in test: ' + url }) };
      }
    });

    // Simula abrir "Nuevo Producto": debe ocultar la sección de variantes,
    // sin tocar red para poblar ninguna sugerencia.
    sandbox.openNewProductModal();
    eq(document.getElementById('variantsSection').style.display, 'none', '"Nuevo Producto" debe ocultar la sección de variantes');
    eq(fetchCalls.length, 0, '"Nuevo Producto" no debe hacer ninguna llamada de red para poblar sugerencias (no depende de products[0])');

    setField(document, 'productName', 'Producto de prueba E2E');
    setField(document, 'productPrice', '42.50');
    setField(document, 'productStock', '10');

    await sandbox.saveProduct();

    eq(alerts.length, 0, `crear un producto sin variantes no debe mostrar ningún alert; alerts=${JSON.stringify(alerts)}`);

    const createCall = adminFetchCalls.find((c) => c.url === '/api/productos' && c.method === 'POST');
    ok(!!createCall, 'saveProduct() debe llamar POST /api/productos para crear el producto');
    ok(
      !('baseId' in createCall.body) && !('shapeId' in createCall.body) && !('variantBase' in createCall.body) && !('variantShape' in createCall.body),
      'el body de creación del producto no debe llevar ningún campo de variantes'
    );

    // REGRESIÓN CLAVE: la estrategia de e4e00ff (copiar Base/Forma como
    // plantilla y asociarlas automáticamente) queda retirada. Si algún día
    // vuelve, esta llamada dejará de tener longitud 0.
    const variantCalls = adminFetchCalls.filter((c) => c.url === '/admin/variantes');
    eq(variantCalls.length, 0, `REGRESIÓN: saveProduct() NO debe llamar a /admin/variantes automáticamente durante la creación (esa era la estrategia de e4e00ff, ya retirada); llamadas=${JSON.stringify(adminFetchCalls.map((c) => c.url))}`);

    // Transición: el Admin pasa a EDITAR el producto real recién creado.
    eq(document.getElementById('productId').value, newProductId, 'tras crear, el formulario debe quedar apuntando al ID REAL devuelto por el backend');
    eq(document.getElementById('modalTitle').textContent, '✏️ Editar Producto', 'tras crear, el modal debe pasar a modo edición');
    eq(document.getElementById('variantsSection').style.display, '', 'tras crear, la sección de variantes debe mostrarse (ya hay un producto real sobre el que trabajar)');
    ok(document.getElementById('productModal')._classListCalls.removeCalls.length === 0, 'el modal NO debe cerrarse tras crear: el Admin debe permanecer en el contexto del producto recién creado');

    // loadProductVariants(newProductId) debe haberse llamado con el ID REAL
    // (consulta sus propias variant-types, que están vacías: producto sin
    // variantes todavía, válido).
    ok(fetchCalls.includes(`/api/productos/${newProductId}/variant-types`), `tras crear, debe consultarse /variant-types del producto REAL (${newProductId}), no de ningún otro; llamadas=${JSON.stringify(fetchCalls)}`);
  }

  // ================= Edición posterior: "+ Añadir" usa el ID real del producto recién creado =================
  {
    const newProductId = 9000 + Math.floor(Math.random() * 90000);
    const adminFetchCalls = [];
    const { sandbox, document } = loadAdminProductsSandbox({
      onFetch: async (url) => ({ ok: true, json: async () => [] }),
      onAdminFetch: async (url, opts) => {
        const body = JSON.parse(opts.body);
        adminFetchCalls.push({ url, method: opts.method, body });
        if (url === '/api/productos') return { ok: true, status: 201, json: async () => ({ id: newProductId, nombre: body.nombre, precio: body.precio }) };
        if (url === '/admin/variantes') return { ok: true, json: async () => ({ success: true, optionId: 1 }) };
        return { ok: false, json: async () => ({}) };
      }
    });

    sandbox.openNewProductModal();
    setField(document, 'productName', 'Producto luego editado E2E');
    setField(document, 'productPrice', '15.00');
    setField(document, 'productStock', '2');
    await sandbox.saveProduct(); // transición a edición sobre newProductId

    // Ahora, exactamente el flujo YA EXISTENTE de "+ Añadir": abrir el modal
    // de variante, rellenar y guardar. saveVariant() lee productId del
    // formulario (ya puesto por saveProduct() en la transición).
    sandbox.openVariantModal('base');
    setField(document, 'variantNameInput', 'Madera');
    setField(document, 'variantPriceDeltaInput', '8');
    setField(document, 'variantStockInput', '20');
    await sandbox.saveVariant();

    const variantCall = adminFetchCalls.find((c) => c.url === '/admin/variantes');
    ok(!!variantCall, '"+ Añadir" debe llamar a POST /admin/variantes');
    eq(variantCall.body.product_id, newProductId, '"+ Añadir" debe asociar la variante al ID REAL del producto recién creado, no a ningún otro');
    eq(variantCall.body.tipo, 'base', 'el tipo debe ser el elegido en openVariantModal');
    eq(variantCall.body.nombre, 'Madera', 'el nombre debe ser el introducido en el formulario de "+ Añadir"');
  }

  // ================= editProduct(): también muestra la sección de variantes =================
  {
    const existingId = 3000 + Math.floor(Math.random() * 100);
    const { sandbox, document } = loadAdminProductsSandbox({
      onFetch: async (url) => {
        if (url === `/api/productos/${existingId}`) {
          return { ok: true, json: async () => ({ id: existingId, nombre: 'Existente', precio: '10.00', stock: 1 }) };
        }
        if (url === `/api/productos/${existingId}/variant-types`) return { ok: true, json: async () => [] };
        return { ok: false, json: async () => ({}) };
      }
    });
    await sandbox.editProduct(existingId);
    eq(document.getElementById('variantsSection').style.display, '', 'editProduct() debe mostrar la sección de variantes');
    eq(document.getElementById('productId').value, existingId, 'editProduct() debe fijar el productId real');
  }

  // ================= Helpers de la estrategia retirada ya no existen =================
  {
    const { sandbox } = loadAdminProductsSandbox();
    eq(typeof sandbox.readVariantChoice, 'undefined', 'readVariantChoice() (helper de la estrategia de copia, e4e00ff) ya no debe existir');
    eq(typeof sandbox.associateVariant, 'undefined', 'associateVariant() (helper de la estrategia de copia, e4e00ff) ya no debe existir');
  }

  // ================= HTML: estructura y ausencia de dependencia de products[0] =================
  {
    const html = readAdminProductsHtml();

    ok(/id="variantsSection"[^>]*style="display:\s*none;?"/.test(html), 'variantsSection debe existir y estar oculto por defecto en el HTML');

    // No debe quedar ninguna llamada a loadProductVariants(null) en el
    // listener de inicialización de página (esa era la dependencia de
    // products[0] en modo creación, ya retirada).
    const domReadyMatch = html.match(/document\.addEventListener\('DOMContentLoaded',[\s\S]*?\}\);/);
    ok(!!domReadyMatch, 'debe existir el listener de inicialización DOMContentLoaded');
    ok(!/loadProductVariants\(null\)/.test(domReadyMatch[0]), 'DOMContentLoaded ya no debe precargar variantes con loadProductVariants(null) (dependía de products[0])');

    ok(!/<select id="variantBase"[^>]*\brequired\b/.test(html), 'el <select> Base sigue sin required (un producto puede tener cero variantes)');
    ok(!/<select id="variantShape"[^>]*\brequired\b/.test(html), 'el <select> Forma sigue sin required');
  }

  console.log(`OK: ${checks} comprobaciones sobre el flujo de creación de productos desde Admin (crear -> ID real -> editar -> "+ Añadir").`);
}

main().catch((err) => {
  console.error('FALLO en check-admin-products-frontend.js:', err.message);
  process.exit(1);
});
