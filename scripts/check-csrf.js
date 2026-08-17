/*
  LITUM3D - P0-SECURITY-01: matriz de protección CSRF (sección 35).

  Prueba, contra rutas administrativas REALES (routes/productos.js y
  routes/admin.js), los 4 casos con cookie/CSRF simulados de forma
  determinista:
    A) auth cookie + sin CSRF                 -> 403
    B) auth cookie + CSRF incorrecto           -> 403
    C) auth cookie + CSRF correcto             -> llega al handler
    D) sin auth  + CSRF "correcto"             -> sigue sin acceso (401)

  Y, por inspección de código fuente, confirma que:
    E) el webhook de Stripe NUNCA usa csrfProtection (firma propia, sección 12)
    F) el checkout público (payments.js, router no-webhook) NUNCA usa
       csrfProtection (accessToken de capability, no cookie de sesión)

  No usa express-session real: monta un middleware de sesión FALSO y mínimo
  (mismo patrón que scripts/check-uploads-privacy.js#startAdminTestServer)
  que solo necesita simular la forma {adminId, csrfToken} que requireAuth.js
  y middleware/csrf.js leen -- esto aísla la prueba de la mecánica de
  cookies/firma (ya cubierta en scripts/check-session-security.js) y se
  centra exclusivamente en la LÓGICA de autorización + CSRF.

  Uso: node scripts/check-csrf.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const express = require('express');

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); checks++; }

const REPO_ROOT = path.join(__dirname, '..');

function installFakeDbModule(fakePool) {
  const dbPath = require.resolve('../config/db');
  const original = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: fakePool } };
  return () => { if (original) require.cache[dbPath] = original; else delete require.cache[dbPath]; };
}

function loadFreshRouter(modRelativePath, fakePool) {
  const restore = installFakeDbModule(fakePool);
  const modPath = require.resolve(modRelativePath);
  delete require.cache[modPath];
  const router = require(modRelativePath);
  restore();
  delete require.cache[modPath];
  return router;
}

// Middleware de sesión FALSO y determinista: el test controla exactamente
// qué "sabe" el servidor (adminId/csrfToken en sesión) mediante headers de
// TEST dedicados, independientes del header real X-CSRF-Token que el
// middleware bajo prueba compara. Esto permite construir los 4 casos A-D sin
// depender de cookies/firma real (ya cubierto por check-session-security.js).
function fakeSessionMiddleware(req, res, next) {
  const testAdminId = req.headers['x-test-admin-id'];
  const testSessionCsrfToken = req.headers['x-test-session-csrf-token'];
  req.session = testAdminId
    ? { adminId: Number(testAdminId), csrfToken: testSessionCsrfToken || undefined, cookie: { secure: false } }
    : { cookie: { secure: false } };
  next();
}

async function startServer(app) {
  return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
}
async function closeServer(server) {
  await new Promise((r) => server.close(r));
}

// =======================================================================
// A-D contra POST /api/productos (routes/productos.js)
// =======================================================================
async function checkMatrixOnProductos() {
  const fakePool = {
    async query(sql, params = []) {
      if (sql.startsWith('INSERT INTO productos')) {
        return [{ insertId: 999 }];
      }
      throw new Error('Fake pool (productos): consulta no reconocida: ' + sql);
    }
  };
  const productosRouter = loadFreshRouter('../routes/productos', fakePool);
  const app = express();
  app.use(express.json());
  app.use(fakeSessionMiddleware);
  app.use(productosRouter);
  const server = await startServer(app);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const body = JSON.stringify({ nombre: 'Test', precio: 10 });
  const jsonHeaders = { 'Content-Type': 'application/json' };

  try {
    const sessionToken = 'session-csrf-token-' + 'a'.repeat(40);

    // A. auth cookie + sin CSRF -> 403
    {
      const res = await fetch(`${base}/api/productos`, {
        method: 'POST',
        headers: { ...jsonHeaders, 'x-test-admin-id': '1', 'x-test-session-csrf-token': sessionToken },
        body
      });
      eq(res.status, 403, 'A) auth + sin header X-CSRF-Token -> 403');
    }

    // B. auth cookie + CSRF incorrecto -> 403
    {
      const res = await fetch(`${base}/api/productos`, {
        method: 'POST',
        headers: { ...jsonHeaders, 'x-test-admin-id': '1', 'x-test-session-csrf-token': sessionToken, 'X-CSRF-Token': 'token-incorrecto-' + 'b'.repeat(40) },
        body
      });
      eq(res.status, 403, 'B) auth + CSRF incorrecto (no coincide con el de sesión) -> 403');
    }

    // C. auth cookie + CSRF correcto -> llega al handler (201)
    {
      const res = await fetch(`${base}/api/productos`, {
        method: 'POST',
        headers: { ...jsonHeaders, 'x-test-admin-id': '1', 'x-test-session-csrf-token': sessionToken, 'X-CSRF-Token': sessionToken },
        body
      });
      eq(res.status, 201, 'C) auth + CSRF correcto -> llega al handler real (201 creado)');
      const data = await res.json();
      eq(data.id, 999, 'C) el handler procesó la petición de verdad (insertId del pool falso)');
    }

    // D. sin auth + CSRF "correcto" -> sigue sin acceso (401, requireAuth corta antes)
    {
      const res = await fetch(`${base}/api/productos`, {
        method: 'POST',
        headers: { ...jsonHeaders, 'X-CSRF-Token': sessionToken }, // sin x-test-admin-id: no hay sesión admin
        body
      });
      eq(res.status, 401, 'D) CRÍTICO: sin sesión admin, un CSRF "correcto" NO basta -- requireAuth corta antes (401)');
    }
  } finally {
    await closeServer(server);
  }
}

// =======================================================================
// A-D contra PUT /admin/pedidos/:id/estado (routes/admin.js) -- segunda
// ruta real para confirmar que la protección no es un caso aislado de un
// solo router.
// =======================================================================
async function checkMatrixOnAdminPedidosEstado() {
  const fakePool = {
    async query(sql, params = []) {
      if (sql.includes('FROM estado_pedido WHERE nombre')) return [[{ id: 3 }]];
      if (sql.includes('FROM pedidos p') && sql.includes('LEFT JOIN usuarios')) return [[{ id: 55, usuario_id: null, estado_id: 1, email: null, nombre: 'Cliente', total: '10.00' }]];
      if (sql.startsWith('INSERT INTO historial_estado_pedido')) return [{ insertId: 1 }];
      if (sql.startsWith('UPDATE pedidos SET estado_id')) return [{ affectedRows: 1 }];
      throw new Error('Fake pool (admin pedidos estado): consulta no reconocida: ' + sql);
    }
  };
  const adminRouter = loadFreshRouter('../routes/admin', fakePool);
  const app = express();
  app.use(express.json());
  app.use(fakeSessionMiddleware);
  app.use('/admin', adminRouter);
  const server = await startServer(app);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const body = JSON.stringify({ estado: 'Confirmado' });
  const jsonHeaders = { 'Content-Type': 'application/json' };

  try {
    const sessionToken = 'session-csrf-token-admin-' + 'c'.repeat(38);

    {
      const res = await fetch(`${base}/admin/pedidos/55/estado`, { method: 'PUT', headers: { ...jsonHeaders, 'x-test-admin-id': '1', 'x-test-session-csrf-token': sessionToken }, body });
      eq(res.status, 403, 'A) admin.js: auth + sin CSRF -> 403');
    }
    {
      const res = await fetch(`${base}/admin/pedidos/55/estado`, { method: 'PUT', headers: { ...jsonHeaders, 'x-test-admin-id': '1', 'x-test-session-csrf-token': sessionToken, 'X-CSRF-Token': 'incorrecto-' + 'd'.repeat(40) }, body });
      eq(res.status, 403, 'B) admin.js: auth + CSRF incorrecto -> 403');
    }
    {
      const res = await fetch(`${base}/admin/pedidos/55/estado`, { method: 'PUT', headers: { ...jsonHeaders, 'x-test-admin-id': '1', 'x-test-session-csrf-token': sessionToken, 'X-CSRF-Token': sessionToken }, body });
      eq(res.status, 200, 'C) admin.js: auth + CSRF correcto -> 200 (llega al handler real)');
    }
    {
      const res = await fetch(`${base}/admin/pedidos/55/estado`, { method: 'PUT', headers: { ...jsonHeaders, 'X-CSRF-Token': sessionToken }, body });
      eq(res.status, 401, 'D) admin.js: sin sesión admin, CSRF "correcto" no basta -> 401');
    }
  } finally {
    await closeServer(server);
  }
}

// =======================================================================
// E) Webhook Stripe: NUNCA usa csrfProtection
// F) Checkout público: NUNCA usa csrfProtection
// =======================================================================
function checkPublicRoutesNeverUseCsrf() {
  const paymentsSrc = fs.readFileSync(path.join(REPO_ROOT, 'routes', 'payments.js'), 'utf8');
  ok(!/csrfProtection/.test(paymentsSrc), 'E/F) routes/payments.js (webhook + checkout público) nunca importa/usa csrfProtection');
  ok(!/require\(.*middleware\/csrf.*\)/.test(paymentsSrc), 'routes/payments.js no importa middleware/csrf en absoluto');

  const uploadsSrc = fs.readFileSync(path.join(REPO_ROOT, 'routes', 'uploads.js'), 'utf8');
  ok(!/csrfProtection/.test(uploadsSrc), 'upload anónimo (routes/uploads.js) tampoco usa csrfProtection (no hay sesión que proteger)');

  const loginSrc = fs.readFileSync(path.join(REPO_ROOT, 'routes', 'admin.js'), 'utf8');
  // Solo la línea de registro de la ruta (middlewares aplicados), no el
  // cuerpo del handler -- evita depender de dónde termina el callback.
  const loginDeclMatch = loginSrc.match(/router\.post\('\/login',[^\n]*\{/);
  ok(loginDeclMatch, 'se localizó la declaración de POST /admin/login en el código fuente');
  ok(!/csrfProtection/.test(loginDeclMatch[0]), 'sección 17 (decisión B): POST /admin/login NO exige CSRF (pre-sesión) -- se apoya en sameSite+rate limit');
  ok(/loginLimiter/.test(loginDeclMatch[0]), 'POST /admin/login SÍ tiene el rate limiter de login wireado');
}

// =======================================================================
async function main() {
  console.log('P0-SECURITY-01 - matriz CSRF A-D sobre POST /api/productos');
  await checkMatrixOnProductos();
  console.log('P0-SECURITY-01 - matriz CSRF A-D sobre PUT /admin/pedidos/:id/estado');
  await checkMatrixOnAdminPedidosEstado();
  console.log('P0-SECURITY-01 - webhook Stripe y checkout público nunca exigen CSRF (E/F)');
  checkPublicRoutesNeverUseCsrf();
  console.log(`OK: ${checks} comprobaciones de la matriz CSRF.`);
}

main().catch((err) => { console.error('FALLO:', err); process.exit(1); });
