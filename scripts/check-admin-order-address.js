/*
  LITUM3D - Dirección de entrega en el detalle Admin de pedidos (informe
  correspondiente).

  Dos capas, sin BD real ni servidor HTTP real (mismo patrón que
  scripts/check-square-shape-retirement.js y
  scripts/check-admin-order-photos-retention.js#H):

  1) Backend: extrae el handler REAL de GET /admin/pedidos/:id/detalle
     (routes/admin.js) del router de Express y lo invoca con un pool falso
     en memoria -- prueba el SQL real, no una reimplementación.
  2) Frontend: sandbox vm sobre el <script> inline REAL de
     views/admin-dashboard.html -- llama a openModal() con un fetch falso
     y lee el HTML final que el propio código de producción genera.

  Uso: node scripts/check-admin-order-address.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); checks++; }

function readFile(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

// =======================================================================
// 1) Backend: routes/admin.js#GET /pedidos/:id/detalle
// =======================================================================

function getRouteHandler(router, method, routePath) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`Ruta no encontrada: ${method.toUpperCase()} ${routePath}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };
  return res;
}

// Fake pool en memoria: solo entiende las consultas concretas que ejecuta
// este endpoint (cabecera de pedido, líneas, imágenes por línea), sobre
// datos de fixture inyectados por cada test -- ninguna real (sección 12:
// "no hardcodees IDs de pedidos").
function makeFakePool({ pedidoRow, usuarioRow, estadoNombre = 'Pendiente' }) {
  return {
    async query(sql, params = []) {
      const norm = sql.replace(/\s+/g, ' ').trim();

      if (/FROM pedidos p\s*JOIN estado_pedido/i.test(norm)) {
        const [id] = params;
        if (!pedidoRow || String(pedidoRow.id) !== String(id)) return [[]];
        const u = pedidoRow.usuario_id != null ? usuarioRow : null;
        return [[{
          id: pedidoRow.id,
          total: pedidoRow.total,
          currency: pedidoRow.currency,
          created_at: pedidoRow.created_at || new Date(),
          estado_nombre: estadoNombre,
          customer_name: pedidoRow.customer_name || (u && u.nombre) || 'Sin nombre',
          email: pedidoRow.customer_email || (u && u.email) || null,
          // Los 4 campos bajo prueba: EXACTAMENTE los de la fila `pedidos`,
          // nunca derivados de `usuarios` (que no tiene city/zip/country, y
          // cuyo campo `direccion` NUNCA debe usarse aquí -- ver test C).
          customer_address: pedidoRow.customer_address,
          customer_city: pedidoRow.customer_city,
          customer_zip: pedidoRow.customer_zip,
          customer_country: pedidoRow.customer_country
        }]];
      }

      if (/FROM detalle_pedidos dp/i.test(norm)) return [[]];
      if (/FROM detalle_pedido_imagenes/i.test(norm)) return [[]];

      throw new Error(`Fake pool: consulta no reconocida -- ${norm}`);
    }
  };
}

async function checkBackendReturnsAddressFields() {
  const adminRouter = require('../routes/admin');
  const detalleHandler = getRouteHandler(adminRouter, 'get', '/pedidos/:id/detalle');
  const dbConfig = require('../config/db');

  // --- A) Consulta real: el texto SQL selecciona los 4 campos, con los
  // nombres reales de columna de `pedidos` (sección 1/3, sin inventar nombres) ---
  {
    const adminSrc = readFile('routes/admin.js');
    const routeMatch = adminSrc.match(/router\.get\('\/pedidos\/:id\/detalle'[\s\S]*?\n\}\);/);
    ok(routeMatch, 'routes/admin.js define GET /pedidos/:id/detalle');
    const routeSrc = routeMatch[0];
    for (const col of ['p.customer_address', 'p.customer_city', 'p.customer_zip', 'p.customer_country']) {
      ok(routeSrc.includes(col), `GET /pedidos/:id/detalle selecciona ${col} (columna real de \`pedidos\`, sin migración/renombrado)`);
    }
    // La consulta no debe hacer fallback a `usuarios` para estos 4 campos
    // (a diferencia de customer_name/email, que sí usan COALESCE con u.*).
    ok(!/COALESCE\([^)]*customer_address/i.test(routeSrc) && !/u\.direccion/i.test(routeSrc), 'la dirección NUNCA se toma de usuarios.direccion ni de ningún COALESCE con la tabla usuarios');
  }

  // --- B) Pedido completo, usuario_id NULL (guest): los 4 campos viajan tal cual ---
  {
    const id = 90001 + Math.floor(Math.random() * 1000);
    dbConfig.pool.query = makeFakePool({
      pedidoRow: {
        id, total: '65.00', currency: 'EUR', usuario_id: null,
        customer_name: 'Cliente Guest', customer_email: 'guest@example.com',
        customer_address: 'Bahnhofstrasse 10', customer_city: 'Bern', customer_zip: '3011', customer_country: 'CH'
      }
    }).query;
    const res = makeRes();
    await detalleHandler({ params: { id: String(id) } }, res);
    eq(res.statusCode, 200, 'guest: 200');
    eq(res.body.order.customer_address, 'Bahnhofstrasse 10', 'guest: customer_address se devuelve tal cual');
    eq(res.body.order.customer_city, 'Bern', 'guest: customer_city se devuelve tal cual');
    eq(res.body.order.customer_zip, '3011', 'guest: customer_zip se devuelve tal cual');
    eq(res.body.order.customer_country, 'CH', 'guest: customer_country se devuelve tal cual');
  }

  // --- C) Usuario registrado cuya dirección de CUENTA es distinta de la
  // dirección de ESTE pedido: debe prevalecer SIEMPRE la del pedido
  // (sección 2: fuente de verdad exclusiva, nunca la cuenta actual) ---
  {
    const id = 91001 + Math.floor(Math.random() * 1000);
    dbConfig.pool.query = makeFakePool({
      pedidoRow: {
        id, total: '30.00', currency: 'EUR', usuario_id: 42,
        customer_address: 'Dirección DEL PEDIDO 7', customer_city: 'Zürich', customer_zip: '8001', customer_country: 'CH'
      },
      usuarioRow: { nombre: 'Usuario Registrado', email: 'user@example.com', direccion: 'Dirección ACTUAL de la cuenta, distinta' }
    }).query;
    const res = makeRes();
    await detalleHandler({ params: { id: String(id) } }, res);
    eq(res.body.order.customer_address, 'Dirección DEL PEDIDO 7', 'usuario registrado: prevalece la dirección del PEDIDO, no la de la cuenta actual del usuario');
  }

  // --- D) Pedido legacy: los 4 campos NULL no rompen el endpoint ---
  {
    const id = 92001 + Math.floor(Math.random() * 1000);
    dbConfig.pool.query = makeFakePool({
      pedidoRow: {
        id, total: '10.00', currency: 'EUR', usuario_id: null,
        customer_address: null, customer_city: null, customer_zip: null, customer_country: null
      }
    }).query;
    const res = makeRes();
    await detalleHandler({ params: { id: String(id) } }, res);
    eq(res.statusCode, 200, 'legacy: 200, el endpoint no falla con los 4 campos NULL');
    eq(res.body.order.customer_address, null, 'legacy: customer_address se devuelve como null (no se inventa un valor)');
    eq(res.body.order.customer_country, null, 'legacy: customer_country se devuelve como null (país sigue siendo desconocido)');
  }
}

// =======================================================================
// 2) Frontend: views/admin-dashboard.html (sandbox vm sobre el <script> real)
// =======================================================================

function readAdminDashboardScript() {
  const html = readFile('views/admin-dashboard.html');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('No se encontró el <script> inline en views/admin-dashboard.html');
  return match[1];
}

function makeElementStub() {
  return {
    textContent: '', innerHTML: '', value: '', style: {},
    classList: { _classes: new Set(), add(c) { this._classes.add(c); }, remove(c) { this._classes.delete(c); }, contains(c) { return this._classes.has(c); } },
    addEventListener() {}
  };
}

function makeDocumentStub() {
  const registry = new Map();
  return {
    getElementById(id) {
      if (!registry.has(id)) registry.set(id, makeElementStub());
      return registry.get(id);
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
    createElement: () => makeElementStub()
  };
}

function buildSandbox(orderFixture) {
  const document = makeDocumentStub();
  const sandbox = {
    console,
    document,
    window: { location: {} },
    fetch: async (url) => {
      if (String(url).includes('/detalle')) {
        return { ok: true, json: async () => ({ order: orderFixture, items: [] }) };
      }
      if (String(url).includes('/historial')) {
        return { ok: true, json: async () => ({ history: [] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
    alert: () => {}
  };
  sandbox.adminFetch = (url, options) => sandbox.fetch(url, options);
  vm.createContext(sandbox);
  vm.runInContext(readAdminDashboardScript(), sandbox);
  return { sandbox, document };
}

async function openModalAndSettle(sandbox, orderId) {
  sandbox.openModal(orderId, 'Pendiente', 'Cliente Test', 50, 'EUR');
  // Dos vueltas de microtask/timer, mismo patrón que
  // check-admin-order-photos-retention.js#checkCancelDeliveryConfirmNeverFetches,
  // para dejar asentar las promesas de fetch().then(...) encadenadas.
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function checkFrontendRendersAddress() {
  // --- Pedido completo: sección visible, con los 4 datos formateados ---
  {
    const orderId = 93001 + Math.floor(Math.random() * 1000);
    const { sandbox, document } = buildSandbox({
      id: orderId, total: 50, currency: 'EUR', estado_nombre: 'Pendiente', customer_name: 'Cliente Test',
      customer_address: 'Bahnhofstrasse 10', customer_city: 'Bern', customer_zip: '3011', customer_country: 'CH'
    });
    await openModalAndSettle(sandbox, orderId);
    const html = document.getElementById('orderInfo').innerHTML;
    ok(/Dirección de entrega/.test(html), 'el detalle incluye la sección "Dirección de entrega"');
    ok(html.includes('Bahnhofstrasse 10'), 'la calle se renderiza tal cual');
    ok(html.includes('3011 Bern'), 'CP y ciudad se combinan en una línea legible ("3011 Bern")');
    ok(html.includes('Suiza (CH)'), 'el país se muestra como nombre + código ("Suiza (CH)"), no solo "CH"');
  }

  // --- Pedido legacy: los 4 NULL -> no rompe, placeholders seguros, SIN inventar país ---
  {
    const orderId = 94001 + Math.floor(Math.random() * 1000);
    const { sandbox, document } = buildSandbox({
      id: orderId, total: 10, currency: 'EUR', estado_nombre: 'Pendiente', customer_name: 'Cliente Legacy',
      customer_address: null, customer_city: null, customer_zip: null, customer_country: null
    });
    await openModalAndSettle(sandbox, orderId);
    const html = document.getElementById('orderInfo').innerHTML;
    ok(/Dirección de entrega/.test(html), 'pedido legacy: la sección sigue apareciendo (no desaparece silenciosamente)');
    ok(!/null|undefined/.test(html), 'pedido legacy: nunca se renderiza el literal "null"/"undefined"');
    ok(!/Suiza|España|Portugal|Francia|Alemania|Italia|\bCH\b|\bES\b|\bPT\b|\bFR\b|\bDE\b|\bIT\b/.test(html.match(/País[\s\S]{0,80}/)[0]), 'pedido legacy: la fila de País NO inventa ningún país (ni CH/Suiza ni ningún otro)');
  }

  // --- Los 6 códigos soportados, uno a uno, vía el formatter real expuesto en el sandbox ---
  {
    const orderId = 95001 + Math.floor(Math.random() * 1000);
    const { sandbox } = buildSandbox({ id: orderId, total: 1, currency: 'EUR', estado_nombre: 'Pendiente', customer_name: 'X' });
    const EXPECTED = { ES: 'España (ES)', PT: 'Portugal (PT)', FR: 'Francia (FR)', CH: 'Suiza (CH)', DE: 'Alemania (DE)', IT: 'Italia (IT)' };
    for (const [code, label] of Object.entries(EXPECTED)) {
      eq(sandbox.formatOrderCountry(code), label, `formatOrderCountry("${code}") === "${label}"`);
    }
    eq(sandbox.formatOrderCountry(null), '-', 'formatOrderCountry(null) -> placeholder "-", nunca un país inventado');
    eq(sandbox.formatOrderCountry(undefined), '-', 'formatOrderCountry(undefined) -> placeholder "-"');
    eq(sandbox.formatOrderCountry('XX'), 'XX', 'un código fuera del mapa se muestra tal cual (nunca se inventa un nombre)');
  }
}

// =======================================================================
// 3) Seguridad (sección 9): Admin-only, no expuesto en ninguna ruta pública
// =======================================================================
function checkAddressOnlyReachableFromAdmin() {
  const adminSrc = readFile('routes/admin.js');
  const routeMatch = adminSrc.match(/router\.get\('\/pedidos\/:id\/detalle'[\s\S]*?\n\}\);/);
  ok(routeMatch[0].includes('requireAuth'), 'GET /pedidos/:id/detalle sigue protegido por requireAuth (Admin-only)');

  // Ninguna ruta pública (routes/productos.js, routes/variantes.js) debe
  // seleccionar customer_address/city/zip/country -- son endpoints de
  // catálogo, nunca deberían tocar la tabla pedidos en absoluto.
  for (const file of ['routes/productos.js', 'routes/variantes.js']) {
    const src = readFile(file);
    ok(!/customer_address|customer_city|customer_zip|customer_country/.test(src), `${file} (rutas públicas) no referencia ningún campo de dirección de pedidos`);
  }
}

async function main() {
  console.log('Informe de dirección de entrega en Admin - backend (routes/admin.js#/pedidos/:id/detalle)');
  await checkBackendReturnsAddressFields();
  console.log('Informe de dirección de entrega en Admin - frontend (views/admin-dashboard.html, sandbox real)');
  await checkFrontendRendersAddress();
  console.log('Informe de dirección de entrega en Admin - seguridad (Admin-only, sin exposición pública)');
  checkAddressOnlyReachableFromAdmin();
  console.log(`OK: ${checks} comprobaciones sobre la dirección de entrega en el detalle Admin de pedidos.`);
}

main().catch(err => {
  console.error('FALLO en check-admin-order-address.js:', err.message, err.stack);
  process.exit(1);
});
