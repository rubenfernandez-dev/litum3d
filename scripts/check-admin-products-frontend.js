/*
  LITUM3D - Test de regresión: persistencia de Base/Forma al CREAR un
  producto desde Admin (fix(admin): persist product variants on creation).

  Causa raíz que este test demuestra: saveProduct() en views/admin-products.html
  creaba el producto vía POST /api/productos pero nunca asociaba las
  selecciones de los <select> Base/Forma -- había un
  "// TODO: asociar base/forma al producto cuando exista endpoint específico"
  aunque el endpoint (POST /admin/variantes) ya existía y ya lo usa "+ Añadir"
  en edición. Bajo el código anterior, saveProduct() solo emite UNA llamada
  de red (la de /api/productos); este test falla con esa versión porque
  espera además las llamadas de asociación con el product_id REAL devuelto
  por la creación.

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
  return {
    textContent: '', innerHTML: '', value: '', style: {}, dataset: {},
    classList: { add() {}, remove() {} },
    addEventListener() {},
    appendChild() {}
  };
}

// <select> real: value/innerHTML necesitan comportamiento propio
// (loadProductVariants reinicia el select reasignando innerHTML como string
// y luego añade <option> reales vía appendChild; saveProduct lee
// selectedOptions[0] para obtener la plantilla nombre/price_delta/stock del
// option cuyo value coincide con el value seleccionado).
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

const BASE_TYPES_FIXTURE = [
  {
    id: 3, nombre: 'Base', options: [
      { id: 15, nombre: 'Base Soga', price_delta: '2.50', stock: 40 }
    ]
  },
  {
    id: 4, nombre: 'Forma', options: [
      { id: 16, nombre: 'cilindrica', price_delta: '0.00', stock: 70 }
    ]
  }
];

async function main() {
  // ================= Creación: producto + Base/Forma se asocian con el ID real =================
  {
    // IDs deliberadamente aleatorios en cada ejecución: el test no debe
    // depender de -- ni el código debe adivinar -- ningún valor fijo. Si
    // saveProduct() alguna vez vuelve a usar un ID hardcodeado o el de
    // "el primer producto", este test lo detecta.
    const suggestionSourceProductId = 1000 + Math.floor(Math.random() * 500); // producto arbitrario del que se cargan las SUGERENCIAS del select
    const newProductId = 9000 + Math.floor(Math.random() * 90000); // id que /api/productos devolverá al crear

    const adminFetchCalls = [];
    const { sandbox, document, alerts } = loadAdminProductsSandbox({
      onFetch: async (url) => {
        if (url === `/api/productos/${suggestionSourceProductId}/variant-types`) {
          return { ok: true, json: async () => BASE_TYPES_FIXTURE };
        }
        if (url === '/api/productos') return { ok: true, json: async () => [] };
        return { ok: false, json: async () => ({}) };
      },
      onAdminFetch: async (url, opts) => {
        const body = JSON.parse(opts.body);
        adminFetchCalls.push({ url, method: opts.method, body });
        if (url === '/api/productos') {
          return { ok: true, status: 201, json: async () => ({ id: newProductId, nombre: body.nombre, precio: body.precio }) };
        }
        if (url === '/admin/variantes') {
          return { ok: true, json: async () => ({ success: true, optionId: 777 }) };
        }
        return { ok: false, json: async () => ({ error: 'unexpected call in test' }) };
      }
    });

    // Simula abrir "Nuevo Producto": las sugerencias del select se cargan
    // desde un producto EXISTENTE cualquiera (comportamiento preexistente,
    // no tocado por este fix) mientras el producto propio aún no existe.
    await sandbox.loadProductVariants(suggestionSourceProductId);
    ok(document.getElementById('variantBase').selectedOptions.length === 0, 'precondición: nada seleccionado todavía en Base');

    setField(document, 'productId', ''); // producto nuevo: sin id
    setField(document, 'productName', 'Producto de prueba E2E');
    setField(document, 'productPrice', '42.50');
    setField(document, 'productStock', '10');
    document.getElementById('variantBase').value = '15'; // opción "Base Soga" cargada arriba
    document.getElementById('variantShape').value = '16'; // opción "cilindrica"

    await sandbox.saveProduct();

    eq(alerts.length, 0, `creación sin fallos no debe mostrar ningún alert; alerts=${JSON.stringify(alerts)}`);

    const createCall = adminFetchCalls.find((c) => c.url === '/api/productos' && c.method === 'POST');
    ok(!!createCall, 'saveProduct() debe llamar POST /api/productos para crear el producto');
    ok(!('baseId' in createCall.body) && !('shapeId' in createCall.body) && !('variantBase' in createCall.body), 'el body de creación del producto no debe llevar campos de variantes (contrato de /api/productos sin cambios)');

    const variantCalls = adminFetchCalls.filter((c) => c.url === '/admin/variantes');
    eq(variantCalls.length, 2, `REGRESIÓN CLAVE: saveProduct() debe asociar Base Y Forma tras crear el producto (el código anterior no hacía ninguna llamada aquí); llamadas=${JSON.stringify(adminFetchCalls.map(c => c.url))}`);

    const baseCall = variantCalls.find((c) => c.body.tipo === 'base');
    const shapeCall = variantCalls.find((c) => c.body.tipo === 'forma');
    ok(!!baseCall && !!shapeCall, 'debe existir una llamada de asociación para "base" y otra para "forma"');

    // El punto central del fix: product_id debe ser el ID REAL devuelto por
    // la creación, nunca el producto usado solo para sugerencias ni ningún
    // valor por defecto/hardcodeado.
    eq(baseCall.body.product_id, newProductId, 'la asociación de Base debe usar el product_id REAL devuelto por POST /api/productos');
    eq(shapeCall.body.product_id, newProductId, 'la asociación de Forma debe usar el product_id REAL devuelto por POST /api/productos');
    ok(baseCall.body.product_id !== suggestionSourceProductId, 'product_id de la asociación NUNCA debe ser el producto usado solo para poblar las sugerencias del select');

    // nombre/price_delta/stock deben venir de la plantilla elegida (copiados
    // del option real, no inventados ni vacíos).
    eq(baseCall.body.nombre, 'Base Soga', 'el nombre asociado debe ser el de la opción elegida en el select');
    eq(baseCall.body.price_delta, 2.5, 'el price_delta asociado debe copiarse del dataset del option elegido');
    eq(baseCall.body.stock, 40, 'el stock asociado debe copiarse del dataset del option elegido');
    eq(shapeCall.body.nombre, 'cilindrica', 'el nombre de Forma debe ser el de la opción elegida');
  }

  // ================= Creación sin seleccionar Base/Forma: sigue siendo válida =================
  {
    const newProductId = 9000 + Math.floor(Math.random() * 90000);
    const adminFetchCalls = [];
    const { sandbox, document, alerts } = loadAdminProductsSandbox({
      onFetch: async () => ({ ok: true, json: async () => [] }),
      onAdminFetch: async (url, opts) => {
        const body = JSON.parse(opts.body);
        adminFetchCalls.push({ url, method: opts.method, body });
        if (url === '/api/productos') return { ok: true, status: 201, json: async () => ({ id: newProductId, nombre: body.nombre, precio: body.precio }) };
        return { ok: false, json: async () => ({ error: 'unexpected call' }) };
      }
    });

    setField(document, 'productId', '');
    setField(document, 'productName', 'Producto sin variantes E2E');
    setField(document, 'productPrice', '19.90');
    setField(document, 'productStock', '5');
    // Base/Forma quedan sin seleccionar (value='' por defecto del stub).

    await sandbox.saveProduct();

    eq(alerts.length, 0, 'crear un producto sin elegir Base/Forma no debe bloquear ni mostrar ningún alert (son opcionales, ver sección 5 del informe)');
    const variantCalls = adminFetchCalls.filter((c) => c.url === '/admin/variantes');
    eq(variantCalls.length, 0, 'si no se seleccionó ninguna plantilla, no debe emitirse ninguna llamada de asociación');
  }

  // ================= Error parcial: producto creado, asociación falla =================
  {
    const newProductId = 9000 + Math.floor(Math.random() * 90000);
    const adminFetchCalls = [];
    const { sandbox, document, alerts } = loadAdminProductsSandbox({
      onFetch: async (url) => {
        if (url === `/api/productos/${newProductId}/variant-types`) return { ok: true, json: async () => [] };
        return { ok: true, json: async () => [] };
      },
      onAdminFetch: async (url, opts) => {
        const body = JSON.parse(opts.body);
        adminFetchCalls.push({ url, method: opts.method, body });
        if (url === '/api/productos') return { ok: true, status: 201, json: async () => ({ id: newProductId, nombre: body.nombre, precio: body.precio }) };
        if (url === '/admin/variantes') {
          if (body.tipo === 'base') return { ok: true, json: async () => ({ success: true, optionId: 1 }) };
          // Forma falla (p.ej. caída transitoria de BD)
          return { ok: false, status: 500, json: async () => ({ error: 'Error al crear variante' }) };
        }
        return { ok: false, json: async () => ({}) };
      }
    });

    setField(document, 'productId', '');
    setField(document, 'productName', 'Producto parcial E2E');
    setField(document, 'productPrice', '25.00');
    setField(document, 'productStock', '3');
    document.getElementById('variantBase').value = '15';
    document.getElementById('variantShape').value = '16';
    // El select necesita opciones reales con dataset para leer la plantilla:
    const baseOpt = { value: '15', textContent: 'Base Soga', dataset: { priceDelta: '2.5', stock: '40' } };
    const shapeOpt = { value: '16', textContent: 'cilindrica', dataset: { priceDelta: '0', stock: '70' } };
    document.getElementById('variantBase').appendChild(baseOpt);
    document.getElementById('variantShape').appendChild(shapeOpt);

    await sandbox.saveProduct();

    ok(alerts.length === 1, `un fallo de asociación debe producir exactamente un alert informativo; alerts=${JSON.stringify(alerts)}`);
    ok(/creado/i.test(alerts[0]) && new RegExp(String(newProductId)).test(alerts[0]), 'el alert debe indicar que el producto SÍ se creó y mostrar su ID real, no ocultar la creación parcial');
    ok(/forma/i.test(alerts[0]), 'el alert debe identificar cuál de las dos variantes falló');
    ok(!/correctamente$/i.test(alerts[0].trim()) && !/guardado correctamente/i.test(alerts[0]), 'el alert de un fallo parcial NUNCA debe leerse como un éxito completo ("guardado correctamente")');

    eq(document.getElementById('productId').value, newProductId, 'tras un fallo parcial, el formulario debe quedar apuntando al producto REAL ya creado (no se pierde el ID) para poder reintentar con "+ Añadir"');
    eq(document.getElementById('modalTitle').textContent, '✏️ Editar Producto', 'tras un fallo parcial, el modal debe pasar a modo edición sobre el producto ya creado, no cerrarse fingiendo éxito');
  }

  // ================= Regresión directa: el código anterior solo hacía 1 llamada =================
  // Documenta explícitamente qué distingue el código nuevo del anterior: con
  // Base y Forma seleccionadas, debe haber MÁS de una llamada de red de
  // escritura. Bajo el código con el TODO original, esto era falso (solo 1).
  {
    const newProductId = 9000 + Math.floor(Math.random() * 90000);
    const adminFetchCalls = [];
    const { sandbox, document } = loadAdminProductsSandbox({
      onFetch: async () => ({ ok: true, json: async () => [] }),
      onAdminFetch: async (url, opts) => {
        adminFetchCalls.push(url);
        if (url === '/api/productos') return { ok: true, status: 201, json: async () => ({ id: newProductId, nombre: 'x', precio: 1 }) };
        return { ok: true, json: async () => ({ success: true }) };
      }
    });
    setField(document, 'productId', '');
    setField(document, 'productName', 'Regresión directa');
    setField(document, 'productPrice', '10');
    setField(document, 'productStock', '1');
    const baseOpt = { value: '15', textContent: 'Base Soga', dataset: { priceDelta: '0', stock: '10' } };
    document.getElementById('variantBase').appendChild(baseOpt);
    document.getElementById('variantBase').value = '15';

    await sandbox.saveProduct();
    ok(adminFetchCalls.length > 1, `con una variante seleccionada, saveProduct() debe emitir más de 1 llamada de red (creación + asociación); con el código anterior (TODO sin implementar) esto era 1. Llamadas: ${JSON.stringify(adminFetchCalls)}`);
  }

  // ================= HTML: Base/Forma ya no se presentan como universalmente obligatorias =================
  {
    const html = readAdminProductsHtml();
    const baseBlock = html.slice(html.indexOf('variantBase'), html.indexOf('variantBase') + 400);
    const shapeBlock = html.slice(html.indexOf('variantShape'), html.indexOf('variantShape') + 400);
    ok(!/<select id="variantBase"[^>]*\brequired\b/.test(html), 'el <select> Base ya no debe llevar el atributo required (evidencia: productos activos sin ninguna variante configurada funcionan correctamente en checkout, ver customization.js#hasSelectableModels)');
    ok(!/<select id="variantShape"[^>]*\brequired\b/.test(html), 'el <select> Forma ya no debe llevar el atributo required');
    ok(!/Base \*<\/label>/.test(html), 'la etiqueta de Base ya no debe presentarse con el asterisco de obligatoriedad');
    ok(!/Forma \*<\/label>/.test(html), 'la etiqueta de Forma ya no debe presentarse con el asterisco de obligatoriedad');
  }

  console.log(`OK: ${checks} comprobaciones sobre la persistencia de Base/Forma al crear un producto desde Admin.`);
}

main().catch((err) => {
  console.error('FALLO en check-admin-products-frontend.js:', err.message);
  process.exit(1);
});
