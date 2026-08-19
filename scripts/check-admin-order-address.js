/*
  LITUM3D - Dirección de entrega Y datos de contacto (email/teléfono) en
  Admin: listado de pedidos y detalle (informes correspondientes).

  Dos capas, sin BD real ni servidor HTTP real (mismo patrón que
  scripts/check-square-shape-retirement.js y
  scripts/check-admin-order-photos-retention.js#H):

  1) Backend: extrae los handlers REALES de GET /admin/api/dashboard
     (listado) y GET /admin/pedidos/:id/detalle (routes/admin.js) del
     router de Express y los invoca con un pool falso en memoria -- prueba
     el SQL real, no una reimplementación.
  2) Frontend: sandbox vm sobre el <script> inline REAL de
     views/admin-dashboard.html -- llama a openModal()/renderOrders() con
     un fetch falso y lee el HTML final que el propio código de producción
     genera.

  Regla bajo prueba en ambas capas (email/teléfono, NO nombre -- ese
  conserva su fallback histórico a `usuarios` sin cambios en esta tarea):
  el dato mostrado es EXCLUSIVAMENTE el de la fila `pedidos` en el momento
  de la compra, nunca el de la cuenta actual del usuario -- ni con
  COALESCE ni con ningún otro fallback.

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

      if (/FROM pedidos p\s*JOIN estado_pedido/i.test(norm) && /WHERE p\.id = \?/i.test(norm)) {
        const [id] = params;
        if (!pedidoRow || String(pedidoRow.id) !== String(id)) return [[]];
        const u = pedidoRow.usuario_id != null ? usuarioRow : null;
        return [[{
          id: pedidoRow.id,
          total: pedidoRow.total,
          currency: pedidoRow.currency,
          created_at: pedidoRow.created_at || new Date(),
          estado_nombre: estadoNombre,
          // customer_name SÍ conserva su fallback histórico a usuarios
          // (fuera de alcance de esta tarea, sin cambios).
          customer_name: pedidoRow.customer_name || (u && u.nombre) || 'Sin nombre',
          // email/phone: EXCLUSIVAMENTE de `pedidos`, NUNCA de `usuarios`
          // (a propósito, aunque `u` exista) -- ver test C/registro.
          email: pedidoRow.customer_email ?? null,
          phone: pedidoRow.customer_phone ?? null,
          // Los 4 campos de dirección: idéntico criterio, ya cubierto desde
          // el commit anterior (`usuarios` no tiene city/zip/country, y su
          // `direccion` NUNCA debe usarse aquí).
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

// Fake pool dedicado a GET /admin/api/dashboard (listado): forma de SQL
// distinta (sin WHERE p.id, con LIMIT 50, devuelve VARIAS filas).
function makeFakeListingPool(rows) {
  return {
    async query(sql) {
      const norm = sql.replace(/\s+/g, ' ').trim();
      if (/FROM pedidos p\s*JOIN estado_pedido/i.test(norm) && /LIMIT 50/i.test(norm)) {
        return [rows.map(r => {
          const u = r.usuario_id != null ? r.usuarioRow : null;
          return {
            id: r.id, usuario_id: r.usuario_id, estado_id: 1, estado_nombre: r.estado_nombre || 'Pendiente',
            total: r.total, currency: r.currency, created_at: r.created_at || new Date(),
            customer_name: r.customer_name || (u && u.nombre) || 'Sin nombre',
            // email: EXCLUSIVAMENTE de `pedidos`, nunca de `usuarios`.
            email: r.customer_email ?? null
          };
        })];
      }
      throw new Error(`Fake listing pool: consulta no reconocida -- ${norm}`);
    }
  };
}

async function checkBackendReturnsAddressFields() {
  const adminRouter = require('../routes/admin');
  const detalleHandler = getRouteHandler(adminRouter, 'get', '/pedidos/:id/detalle');
  const dbConfig = require('../config/db');

  // --- A) Consulta real: el texto SQL selecciona los 6 campos (dirección +
  // email + phone), con los nombres reales de columna de `pedidos`
  // (sección 1/3, sin inventar nombres) ---
  {
    const adminSrc = readFile('routes/admin.js');
    const routeMatch = adminSrc.match(/router\.get\('\/pedidos\/:id\/detalle'[\s\S]*?\n\}\);/);
    ok(routeMatch, 'routes/admin.js define GET /pedidos/:id/detalle');
    const routeSrc = routeMatch[0];
    for (const col of ['p.customer_address', 'p.customer_city', 'p.customer_zip', 'p.customer_country', 'p.customer_email', 'p.customer_phone']) {
      ok(routeSrc.includes(col), `GET /pedidos/:id/detalle selecciona ${col} (columna real de \`pedidos\`, sin migración/renombrado)`);
    }
    // Ni dirección ni email/teléfono deben hacer fallback a `usuarios` --
    // a diferencia de customer_name, que SÍ sigue usando COALESCE con
    // u.nombre (fuera de alcance, sin cambios en esta tarea).
    ok(!/COALESCE\([^)]*customer_address/i.test(routeSrc) && !/u\.direccion/i.test(routeSrc), 'la dirección NUNCA se toma de usuarios.direccion ni de ningún COALESCE con la tabla usuarios');
    ok(!/COALESCE\([^)]*customer_email/i.test(routeSrc), 'el email NUNCA usa COALESCE con la tabla usuarios (dato histórico del pedido, no de la cuenta)');
    ok(!/COALESCE\([^)]*customer_phone/i.test(routeSrc), 'el teléfono NUNCA usa COALESCE con la tabla usuarios');
    ok(!/u\.email/i.test(routeSrc), 'usuarios.email ya no se referencia en absoluto en este endpoint');
    ok(!/u\.telefono/i.test(routeSrc), 'usuarios.telefono nunca se referencia en este endpoint');
  }

  // --- B) Pedido completo, usuario_id NULL (guest): los 6 campos viajan tal cual ---
  {
    const id = 90001 + Math.floor(Math.random() * 1000);
    dbConfig.pool.query = makeFakePool({
      pedidoRow: {
        id, total: '65.00', currency: 'EUR', usuario_id: null,
        customer_name: 'Cliente Guest', customer_email: 'guest@example.com', customer_phone: '+41 79 000 00 01',
        customer_address: 'Bahnhofstrasse 10', customer_city: 'Bern', customer_zip: '3011', customer_country: 'CH'
      }
    }).query;
    const res = makeRes();
    await detalleHandler({ params: { id: String(id) } }, res);
    eq(res.statusCode, 200, 'guest: 200');
    eq(res.body.order.email, 'guest@example.com', 'guest: email se devuelve tal cual (pertenece al pedido, no requiere cuenta)');
    eq(res.body.order.phone, '+41 79 000 00 01', 'guest: phone se devuelve tal cual');
    eq(res.body.order.customer_address, 'Bahnhofstrasse 10', 'guest: customer_address se devuelve tal cual');
    eq(res.body.order.customer_city, 'Bern', 'guest: customer_city se devuelve tal cual');
    eq(res.body.order.customer_zip, '3011', 'guest: customer_zip se devuelve tal cual');
    eq(res.body.order.customer_country, 'CH', 'guest: customer_country se devuelve tal cual');
  }

  // --- C) Usuario registrado cuya CUENTA tiene email/teléfono/dirección
  // distintos de los usados en ESTE pedido: deben prevalecer SIEMPRE los
  // del pedido (sección 2/3/9: fuente de verdad exclusiva, nunca la cuenta
  // actual) ---
  {
    const id = 91001 + Math.floor(Math.random() * 1000);
    dbConfig.pool.query = makeFakePool({
      pedidoRow: {
        id, total: '30.00', currency: 'EUR', usuario_id: 42,
        customer_email: 'pedido@example.com', customer_phone: '+41 79 111 11 11',
        customer_address: 'Dirección DEL PEDIDO 7', customer_city: 'Zürich', customer_zip: '8001', customer_country: 'CH'
      },
      usuarioRow: {
        nombre: 'Usuario Registrado', email: 'nuevo-email-cuenta@example.com', telefono: '+41 79 999 99 99',
        direccion: 'Dirección ACTUAL de la cuenta, distinta'
      }
    }).query;
    const res = makeRes();
    await detalleHandler({ params: { id: String(id) } }, res);
    eq(res.body.order.email, 'pedido@example.com', 'usuario registrado: prevalece el email del PEDIDO, nunca "nuevo-email-cuenta@example.com" de la cuenta actual');
    eq(res.body.order.phone, '+41 79 111 11 11', 'usuario registrado: prevalece el teléfono del PEDIDO, no el de la cuenta actual');
    eq(res.body.order.customer_address, 'Dirección DEL PEDIDO 7', 'usuario registrado: prevalece la dirección del PEDIDO, no la de la cuenta actual del usuario');
  }

  // --- D) Pedido legacy: los 6 campos NULL no rompen el endpoint ---
  {
    const id = 92001 + Math.floor(Math.random() * 1000);
    dbConfig.pool.query = makeFakePool({
      pedidoRow: {
        id, total: '10.00', currency: 'EUR', usuario_id: null,
        customer_email: null, customer_phone: null,
        customer_address: null, customer_city: null, customer_zip: null, customer_country: null
      }
    }).query;
    const res = makeRes();
    await detalleHandler({ params: { id: String(id) } }, res);
    eq(res.statusCode, 200, 'legacy: 200, el endpoint no falla con los 6 campos NULL');
    eq(res.body.order.email, null, 'legacy: email se devuelve como null (nunca se inventa)');
    eq(res.body.order.phone, null, 'legacy: phone se devuelve como null');
    eq(res.body.order.customer_address, null, 'legacy: customer_address se devuelve como null (no se inventa un valor)');
    eq(res.body.order.customer_country, null, 'legacy: customer_country se devuelve como null (país sigue siendo desconocido)');
  }
}

async function checkListingReturnsEmail() {
  const adminRouter = require('../routes/admin');
  const listingHandler = getRouteHandler(adminRouter, 'get', '/api/dashboard');
  const dbConfig = require('../config/db');

  // --- Consulta real: selecciona email desde `pedidos`, sin COALESCE con usuarios ---
  {
    const adminSrc = readFile('routes/admin.js');
    const routeMatch = adminSrc.match(/router\.get\('\/api\/dashboard'[\s\S]*?\n\}\);/);
    ok(routeMatch, "routes/admin.js define GET /api/dashboard");
    const routeSrc = routeMatch[0];
    ok(routeSrc.includes('p.customer_email'), 'GET /api/dashboard selecciona p.customer_email en el listado');
    ok(!/COALESCE\([^)]*customer_email/i.test(routeSrc), 'el listado NUNCA hace COALESCE de email con usuarios');
    ok(!/u\.email/i.test(routeSrc), 'el listado no referencia usuarios.email en absoluto');
  }

  const idWithEmail = 96001 + Math.floor(Math.random() * 1000);
  const idRegisteredDifferentAccount = 97001 + Math.floor(Math.random() * 1000);
  const idNullEmail = 98001 + Math.floor(Math.random() * 1000);

  dbConfig.pool.query = makeFakeListingPool([
    { id: idWithEmail, total: '20.00', currency: 'EUR', usuario_id: null, customer_email: 'listado@example.com' },
    {
      id: idRegisteredDifferentAccount, total: '15.00', currency: 'EUR', usuario_id: 7,
      customer_email: 'pedido-listado@example.com', usuarioRow: { nombre: 'Reg', email: 'cuenta-listado@example.com' }
    },
    { id: idNullEmail, total: '5.00', currency: 'EUR', usuario_id: null, customer_email: null }
  ]).query;

  const res = makeRes();
  await listingHandler({}, res);
  eq(res.statusCode, 200, 'listado: 200');
  const byId = Object.fromEntries(res.body.orders.map(o => [o.id, o]));
  eq(byId[idWithEmail].email, 'listado@example.com', 'listado: email del pedido se devuelve tal cual');
  eq(byId[idRegisteredDifferentAccount].email, 'pedido-listado@example.com', 'listado: prevalece el email del PEDIDO sobre el de la cuenta del usuario registrado');
  eq(byId[idNullEmail].email, null, 'listado: pedido sin email -> null (no se rellena con nada)');
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
  // --- Pedido completo: sección visible, con los 4 datos de dirección + email/teléfono formateados ---
  {
    const orderId = 93001 + Math.floor(Math.random() * 1000);
    const { sandbox, document } = buildSandbox({
      id: orderId, total: 50, currency: 'EUR', estado_nombre: 'Pendiente', customer_name: 'Cliente Test',
      email: 'cliente@example.com', phone: '+41 79 222 22 22',
      customer_address: 'Bahnhofstrasse 10', customer_city: 'Bern', customer_zip: '3011', customer_country: 'CH'
    });
    await openModalAndSettle(sandbox, orderId);
    const html = document.getElementById('orderInfo').innerHTML;
    ok(/Dirección de entrega/.test(html), 'el detalle incluye la sección "Dirección de entrega"');
    ok(html.includes('Bahnhofstrasse 10'), 'la calle se renderiza tal cual');
    ok(html.includes('3011 Bern'), 'CP y ciudad se combinan en una línea legible ("3011 Bern")');
    ok(html.includes('Suiza (CH)'), 'el país se muestra como nombre + código ("Suiza (CH)"), no solo "CH"');
    ok(/detail-label">Email<\/span>[\s\S]{0,80}?cliente@example\.com/.test(html), 'el detalle muestra el email del pedido en una fila "Email"');
    ok(/detail-label">Teléfono<\/span>[\s\S]{0,80}?\+41 79 222 22 22/.test(html), 'el detalle muestra el teléfono del pedido en una fila "Teléfono"');
    // No duplicado: "Cliente" (nombre) sigue apareciendo una sola vez.
    eq((html.match(/detail-label">Cliente</g) || []).length, 1, 'la fila "Cliente" no se duplica al añadir Email/Teléfono');
  }

  // --- Pedido legacy: los 6 NULL -> no rompe, placeholders seguros, SIN inventar país/email/teléfono ---
  {
    const orderId = 94001 + Math.floor(Math.random() * 1000);
    const { sandbox, document } = buildSandbox({
      id: orderId, total: 10, currency: 'EUR', estado_nombre: 'Pendiente', customer_name: 'Cliente Legacy',
      email: null, phone: null,
      customer_address: null, customer_city: null, customer_zip: null, customer_country: null
    });
    await openModalAndSettle(sandbox, orderId);
    const html = document.getElementById('orderInfo').innerHTML;
    ok(/Dirección de entrega/.test(html), 'pedido legacy: la sección sigue apareciendo (no desaparece silenciosamente)');
    ok(!/null|undefined/.test(html), 'pedido legacy: nunca se renderiza el literal "null"/"undefined"');
    ok(!/Suiza|España|Portugal|Francia|Alemania|Italia|\bCH\b|\bES\b|\bPT\b|\bFR\b|\bDE\b|\bIT\b/.test(html.match(/País[\s\S]{0,80}/)[0]), 'pedido legacy: la fila de País NO inventa ningún país (ni CH/Suiza ni ningún otro)');
    ok(/detail-label">Email<\/span>[\s\S]{0,80}?detail-value">-<\/span>/.test(html), 'pedido legacy: Email muestra el placeholder "-"');
    ok(/detail-label">Teléfono<\/span>[\s\S]{0,80}?detail-value">-<\/span>/.test(html), 'pedido legacy: Teléfono muestra el placeholder "-"');
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

// --- Tabla/listado principal: columna Email visible sin abrir el detalle ---
function checkTableRendersEmail() {
  const { sandbox, document } = buildSandbox({});
  const idWithEmail = 99001 + Math.floor(Math.random() * 1000);
  const idNullEmail = 99501 + Math.floor(Math.random() * 1000);

  sandbox.renderOrders([
    { id: idWithEmail, created_at: new Date().toISOString(), customer_name: 'Cliente Tabla', email: 'tabla@example.com', total: '25.00', currency: 'EUR', estado_nombre: 'Pendiente' },
    { id: idNullEmail, created_at: new Date().toISOString(), customer_name: 'Cliente Sin Email', email: null, total: '12.00', currency: 'EUR', estado_nombre: 'Pendiente' }
  ]);

  const html = document.getElementById('ordersContent').innerHTML;
  ok(/<th class="col-email">Email<\/th>/.test(html), 'la tabla principal tiene una columna de cabecera "Email"');
  ok(html.includes('tabla@example.com'), 'la fila con email lo muestra en la tabla, sin necesidad de abrir el detalle');
  ok(/col-email"><span class="order-email">-<\/span>/.test(html), 'la fila sin email muestra el placeholder "-" en la tabla');
}

// =======================================================================
// 3) Seguridad (sección 9): Admin-only, no expuesto en ninguna ruta pública
// =======================================================================
function checkAddressOnlyReachableFromAdmin() {
  const adminSrc = readFile('routes/admin.js');

  const detalleMatch = adminSrc.match(/router\.get\('\/pedidos\/:id\/detalle'[\s\S]*?\n\}\);/);
  ok(detalleMatch[0].includes('requireAuth'), 'GET /pedidos/:id/detalle sigue protegido por requireAuth (Admin-only)');

  const dashboardMatch = adminSrc.match(/router\.get\('\/api\/dashboard'[\s\S]*?\n\}\);/);
  ok(dashboardMatch[0].includes('requireAuth'), 'GET /api/dashboard (listado) sigue protegido por requireAuth (Admin-only)');

  // Ninguna ruta pública (routes/productos.js, routes/variantes.js) debe
  // seleccionar customer_address/city/zip/country/email/phone -- son
  // endpoints de catálogo, nunca deberían tocar la tabla pedidos en absoluto.
  for (const file of ['routes/productos.js', 'routes/variantes.js']) {
    const src = readFile(file);
    ok(!/customer_address|customer_city|customer_zip|customer_country|customer_email|customer_phone/.test(src), `${file} (rutas públicas) no referencia ningún campo de contacto/dirección de pedidos`);
  }

  // No se registra en logs el contacto completo de un pedido (sección 11):
  // ningún console.log/console.error de este endpoint menciona
  // email/phone/orders[0] directamente.
  const consoleCalls = (detalleMatch[0].match(/console\.(log|error)\([^)]*\)/g) || []).join(' ');
  ok(!/email|phone|orders\[0\]/i.test(consoleCalls), 'GET /pedidos/:id/detalle no registra email/teléfono en logs');
}

async function main() {
  console.log('Informe de dirección/contacto en Admin - backend detalle (routes/admin.js#/pedidos/:id/detalle)');
  await checkBackendReturnsAddressFields();
  console.log('Informe de dirección/contacto en Admin - backend listado (routes/admin.js#/api/dashboard)');
  await checkListingReturnsEmail();
  console.log('Informe de dirección/contacto en Admin - frontend detalle (views/admin-dashboard.html, sandbox real)');
  await checkFrontendRendersAddress();
  console.log('Informe de dirección/contacto en Admin - frontend tabla principal');
  checkTableRendersEmail();
  console.log('Informe de dirección/contacto en Admin - seguridad (Admin-only, sin exposición pública)');
  checkAddressOnlyReachableFromAdmin();
  console.log(`OK: ${checks} comprobaciones sobre dirección/email/teléfono en Admin (listado y detalle de pedidos).`);
}

main().catch(err => {
  console.error('FALLO en check-admin-order-address.js:', err.message, err.stack);
  process.exit(1);
});
