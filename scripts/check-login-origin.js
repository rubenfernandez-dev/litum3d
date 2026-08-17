/*
  LITUM3D - P0-SECURITY-01 (cierre final, bloqueante 1): same-origin EXACTO
  (scheme+host+puerto) sobre POST /admin/login.

  Cubre la matriz completa pedida (A-I):
    A) expected https://litum3d.com, Origin https://litum3d.com -> permitido.
    B) Origin http://litum3d.com (mismo host, distinto scheme) -> 403.
    C) Origin https://www.litum3d.com (subdominio) -> 403.
    D) Origin https://litum3d.com:444 (puerto distinto) -> 403.
    E) Referer https://litum3d.com/admin/login, sin Origin -> permitido.
    F) Referer http://litum3d.com/admin/login (scheme distinto) -> 403.
    G) Origin: null -> 403.
    H) sin Origin/Referer -> 403.
    I) Host:evil.example + Origin:https://evil.example, expectedOrigin
       configurado = https://litum3d.com -> 403 (el Host de la petición
       nunca es la autoridad).

  Dos capas de test:
    1) Lógica pura (isSameOriginRequest/parseOrigin) con objetos req falsos
       y un expectedOrigin fijo -- exactamente la matriz de arriba.
    2) HTTP real contra POST /admin/login (routes/admin.js), controlando
       BASE_URL vía swap del require-cache para que el singleton
       requireSameOrigin de middleware/sameOrigin.js resuelva un
       expectedOrigin conocido -- confirma que la ruta real está wireada y
       que las peticiones legítimas (con Origin igual a BASE_URL) siguen
       funcionando de principio a fin (login + regenerate + CSRF token).

  Uso: node scripts/check-login-origin.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); checks++; }

const REPO_ROOT = path.join(__dirname, '..');
const TEST_SESSION_SECRET = 'test-session-secret-' + 'x'.repeat(32);

// =======================================================================
// 1) Lógica pura: matriz A-I exacta, sin servidor ni proceso hijo.
// =======================================================================
function checkExactOriginMatrix() {
  const { isSameOriginRequest, parseOrigin } = require('../middleware/sameOrigin');
  const EXPECTED = 'https://litum3d.com';

  // A. Origin exacto -> permitido.
  ok(isSameOriginRequest({ headers: { origin: 'https://litum3d.com' } }, EXPECTED), 'A) Origin idéntico al esperado -> permitido');

  // B. mismo host, scheme distinto -> 403.
  ok(!isSameOriginRequest({ headers: { origin: 'http://litum3d.com' } }, EXPECTED), 'B) http:// contra expected https:// (mismo host) -> rechazado');

  // C. subdominio -> 403 (nunca same-origin salvo allowlist explícita, que no existe aquí).
  ok(!isSameOriginRequest({ headers: { origin: 'https://www.litum3d.com' } }, EXPECTED), 'C) www.litum3d.com (subdominio) -> rechazado');

  // D. puerto distinto -> 403.
  ok(!isSameOriginRequest({ headers: { origin: 'https://litum3d.com:444' } }, EXPECTED), 'D) puerto :444 distinto del esperado (443 implícito) -> rechazado');

  // E. sin Origin, Referer same-origin -> permitido (el path del Referer no importa).
  ok(isSameOriginRequest({ headers: { referer: 'https://litum3d.com/admin/login?x=1' } }, EXPECTED), 'E) sin Origin, Referer con origin exacto -> permitido (path/query ignorados)');

  // F. Referer con scheme distinto -> 403.
  ok(!isSameOriginRequest({ headers: { referer: 'http://litum3d.com/admin/login' } }, EXPECTED), 'F) Referer http:// contra expected https:// -> rechazado');

  // G. Origin: "null" (petición desde contexto opaco: sandbox iframe, file://, etc.) -> 403.
  ok(!isSameOriginRequest({ headers: { origin: 'null' } }, EXPECTED), 'G) Origin: null (string literal "null") -> rechazado');

  // H. ni Origin ni Referer -> 403 (política explícita).
  ok(!isSameOriginRequest({ headers: {} }, EXPECTED), 'H) sin Origin ni Referer -> rechazado (no se puede demostrar same-origin)');

  // I. CRÍTICO: Host de la petición controlado por el atacante, IGUAL a su
  // propio Origin, mientras expectedOrigin es el dominio real configurado
  // server-side -- el Host de la petición nunca debe ser la autoridad.
  ok(!isSameOriginRequest({ headers: { host: 'evil.example', origin: 'https://evil.example' } }, EXPECTED), 'I) CRÍTICO: Host+Origin ambos = evil.example, pero expectedOrigin=litum3d.com -> rechazado (Host del request nunca es la autoridad)');

  // Extra: URL inválida en Origin -> nunca lanza, se trata como rechazo.
  ok(!isSameOriginRequest({ headers: { origin: 'no-es-una-url' } }, EXPECTED), 'Origin no parseable como URL -> rechazado, sin lanzar');
  eq(parseOrigin('no-es-una-url'), null, 'parseOrigin(\'no-es-una-url\') -> null');
  eq(parseOrigin('https://litum3d.com/algun/path?x=1'), 'https://litum3d.com', 'parseOrigin descarta path/query/hash, conserva solo scheme+host+puerto');

  // Extra: substring tricks explícitos (ya cubiertos por C, se repite con
  // otros patrones típicos de bypass de comparaciones ingenuas).
  ok(!isSameOriginRequest({ headers: { origin: 'https://litum3d.com.evil.example' } }, EXPECTED), 'CRÍTICO: "litum3d.com.evil.example" no cuela por contener el dominio legítimo como substring/sufijo de host');
  ok(!isSameOriginRequest({ headers: { origin: 'https://evil.example/?o=https://litum3d.com' } }, EXPECTED), 'CRÍTICO: un query string con el origin legítimo dentro no cuela');
  ok(!isSameOriginRequest({ headers: { origin: 'https://evil.example#https://litum3d.com' } }, EXPECTED), 'CRÍTICO: un fragment con el origin legítimo dentro no cuela');

  // Sin expectedOrigin configurado (producción mal configurada, aunque
  // server.js debería haber hecho fail-fast antes de llegar aquí) -> nunca
  // permite nada, nunca deriva la autoridad del propio request.
  ok(!isSameOriginRequest({ headers: { origin: 'https://litum3d.com' } }, null), 'sin expectedOrigin -> siempre rechazado, incluso con un Origin "razonable"');
  ok(!isSameOriginRequest({ headers: { origin: 'https://litum3d.com' } }, undefined), 'sin expectedOrigin (undefined) -> siempre rechazado');
}

// =======================================================================
// computeExpectedOrigin(): autoridad BASE_URL/PUBLIC_BASE_URL, exacta.
// =======================================================================
function checkComputeExpectedOrigin() {
  const { computeExpectedOrigin } = require('../middleware/sameOrigin');

  eq(computeExpectedOrigin({ env: { BASE_URL: 'https://litum3d.com' } }), 'https://litum3d.com', 'BASE_URL válida -> origin exacto (sin path/trailing slash)');
  eq(computeExpectedOrigin({ env: { BASE_URL: 'https://litum3d.com/' } }), 'https://litum3d.com', 'BASE_URL con trailing slash -> mismo origin (el path se descarta)');
  eq(
    computeExpectedOrigin({ env: { BASE_URL: 'https://internal.example', PUBLIC_BASE_URL: 'https://litum3d.com' } }),
    'https://litum3d.com',
    'PUBLIC_BASE_URL tiene prioridad sobre BASE_URL (misma precedencia que routes/payments.js)'
  );
  eq(computeExpectedOrigin({ env: {} }), null, 'sin BASE_URL/PUBLIC_BASE_URL y sin fallback -> null (server.js debe fail-fast con esto en producción)');
  eq(computeExpectedOrigin({ env: {}, allowLocalhostFallback: true }), 'http://localhost:3000', 'con fallback permitido (solo fuera de producción) y sin config -> localhost:PORT por defecto (3000)');
  eq(computeExpectedOrigin({ env: { PORT: '4200' }, allowLocalhostFallback: true }), 'http://localhost:4200', 'el fallback de desarrollo respeta PORT si está configurado');
  eq(computeExpectedOrigin({ env: { BASE_URL: 'no-es-una-url' }, allowLocalhostFallback: true }), 'http://localhost:3000', 'BASE_URL inválida + fallback permitido -> localhost (nunca lanza, nunca usa el valor inválido)');
  eq(computeExpectedOrigin({ env: { BASE_URL: 'no-es-una-url' }, allowLocalhostFallback: false }), null, 'BASE_URL inválida SIN fallback (producción) -> null explícito, para que server.js haga fail-fast');
}

// =======================================================================
// 2) HTTP real: POST /admin/login con BASE_URL controlada.
// =======================================================================
function installFakeDbModule(fakePool) {
  const dbPath = require.resolve('../config/db');
  const original = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: fakePool } };
  return () => { if (original) require.cache[dbPath] = original; else delete require.cache[dbPath]; };
}

// Carga routes/admin.js (y, transitivamente, middleware/sameOrigin.js) con
// process.env.BASE_URL fijado a un valor conocido ANTES del require, para
// que el singleton EXPECTED_ORIGIN de sameOrigin.js se calcule con ese valor
// -- y lo revierte todo (env + caches) al terminar.
async function withAdminRouterAndBaseUrl(baseUrlEnv, fakePool, fn) {
  const prevBaseUrl = process.env.BASE_URL;
  const prevPublicBaseUrl = process.env.PUBLIC_BASE_URL;
  process.env.BASE_URL = baseUrlEnv;
  delete process.env.PUBLIC_BASE_URL;

  const sameOriginPath = require.resolve('../middleware/sameOrigin');
  const adminPath = require.resolve('../routes/admin');
  delete require.cache[sameOriginPath];
  delete require.cache[adminPath];

  const restoreDb = installFakeDbModule(fakePool);
  const adminRouter = require('../routes/admin');
  restoreDb();

  try {
    await fn(adminRouter);
  } finally {
    delete require.cache[sameOriginPath];
    delete require.cache[adminPath];
    if (prevBaseUrl === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = prevBaseUrl;
    if (prevPublicBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = prevPublicBaseUrl;
  }
}

async function startServer(adminRouter) {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: TEST_SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: false } }));
  app.use('/admin', adminRouter);
  return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
}
async function closeServer(server) { await new Promise((r) => server.close(r)); }

async function checkHttpIntegration() {
  const plainPassword = 'CorrectHorseBatteryStaple!1';
  let dbQueryCount = 0;
  const adminRow = { id: 9, email: 'admin@test.local', nombre: 'Test Admin', contraseña: await bcrypt.hash(plainPassword, 10) };
  const fakePool = {
    async query(sql, params = []) {
      dbQueryCount++;
      if (sql.includes('FROM usuarios WHERE email')) {
        return [params[0] === adminRow.email ? [adminRow] : []];
      }
      throw new Error('Fake pool (login-origin http): consulta no reconocida: ' + sql);
    }
  };
  const jsonHeaders = { 'Content-Type': 'application/json' };
  const validBody = JSON.stringify({ email: adminRow.email, password: plainPassword });

  await withAdminRouterAndBaseUrl('https://litum3d.example-test', fakePool, async (adminRouter) => {
    const server = await startServer(adminRouter);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      // Origin EXACTAMENTE igual a BASE_URL -> permitido, y el login
      // funciona de principio a fin (regenerate + csrf token).
      dbQueryCount = 0;
      const okRes = await fetch(`${base}/admin/login`, { method: 'POST', headers: { ...jsonHeaders, Origin: 'https://litum3d.example-test' }, body: validBody });
      eq(okRes.status, 200, 'HTTP real: Origin == BASE_URL exacto -> 200, login completo funciona');
      ok(dbQueryCount > 0, 'HTTP real: la petición same-origin sí llegó a consultar la BD');

      // Mismo host, scheme http:// en vez de https:// -> 403 (sección 3/D).
      const wrongSchemeRes = await fetch(`${base}/admin/login`, { method: 'POST', headers: { ...jsonHeaders, Origin: 'http://litum3d.example-test' }, body: validBody });
      eq(wrongSchemeRes.status, 403, 'HTTP real: mismo host, scheme distinto (http vs https) -> 403');

      // Puerto distinto -> 403.
      const wrongPortRes = await fetch(`${base}/admin/login`, { method: 'POST', headers: { ...jsonHeaders, Origin: 'https://litum3d.example-test:8443' }, body: validBody });
      eq(wrongPortRes.status, 403, 'HTTP real: mismo host+scheme, puerto distinto -> 403');

      // Origin de un atacante, con Host también del atacante (I): 403.
      dbQueryCount = 0;
      const evilRes = await fetch(`${base}/admin/login`, { method: 'POST', headers: { ...jsonHeaders, Origin: 'https://evil.example' }, body: validBody });
      eq(evilRes.status, 403, 'HTTP real: Origin de un atacante (aunque su propio Host "coincida" con su Origin) -> 403');
      eq(dbQueryCount, 0, 'HTTP real: con Origin ajeno, nunca se llega a consultar la BD');
    } finally {
      await closeServer(server);
    }
  });
}

// Confirma que, en desarrollo (BASE_URL ausente), el fallback a
// http://localhost:<PORT> deja pasar una petición legítima del propio
// entorno de desarrollo -- sección 2 del ticket: "no debilitar producción
// para facilitar tests", pero desarrollo SÍ debe poder funcionar sin
// configurar BASE_URL a mano.
async function checkDevFallbackStillWorks() {
  const plainPassword = 'CorrectHorseBatteryStaple!1';
  const adminRow = { id: 9, email: 'admin@test.local', nombre: 'Test Admin', contraseña: await bcrypt.hash(plainPassword, 10) };
  const fakePool = {
    async query(sql, params = []) {
      if (sql.includes('FROM usuarios WHERE email')) return [params[0] === adminRow.email ? [adminRow] : []];
      throw new Error('Fake pool: consulta no reconocida: ' + sql);
    }
  };

  const prevBaseUrl = process.env.BASE_URL;
  const prevPort = process.env.PORT;
  delete process.env.BASE_URL;
  process.env.PORT = '3000'; // el fallback usa PORT, no el puerto real del listener de test

  const sameOriginPath = require.resolve('../middleware/sameOrigin');
  const adminPath = require.resolve('../routes/admin');
  delete require.cache[sameOriginPath];
  delete require.cache[adminPath];
  const restoreDb = installFakeDbModule(fakePool);
  const adminRouter = require('../routes/admin');
  restoreDb();

  try {
    const server = await startServer(adminRouter);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const res = await fetch(`${base}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' }, // coincide con el fallback, NO con el puerto efímero del listener
        body: JSON.stringify({ email: adminRow.email, password: plainPassword })
      });
      eq(res.status, 200, 'desarrollo sin BASE_URL configurada: Origin http://localhost:<PORT> (fallback) -> permitido');
    } finally {
      await closeServer(server);
    }
  } finally {
    delete require.cache[sameOriginPath];
    delete require.cache[adminPath];
    if (prevBaseUrl === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = prevBaseUrl;
    if (prevPort === undefined) delete process.env.PORT; else process.env.PORT = prevPort;
  }
}

// =======================================================================
// Comprobación de fuente: nunca substring matching, siempre new URL(...).origin.
// =======================================================================
function checkSourceNeverUsesSubstringMatching() {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'middleware', 'sameOrigin.js'), 'utf8');
  ok(!/\.includes\(/.test(src), 'middleware/sameOrigin.js nunca usa .includes() para comparar origin/host');
  ok(!/\.endsWith\(/.test(src), 'middleware/sameOrigin.js nunca usa .endsWith()');
  ok(/\.origin\b/.test(src), 'middleware/sameOrigin.js usa .origin (scheme+host+puerto), no .host');
  ok(/new URL\(/.test(src), 'middleware/sameOrigin.js parsea con new URL(...), no con regex/substring ad-hoc');

  const adminSrc = fs.readFileSync(path.join(REPO_ROOT, 'routes', 'admin.js'), 'utf8');
  const loginDeclMatch = adminSrc.match(/router\.post\('\/login',[^\n]*\{/);
  ok(loginDeclMatch, 'se localizó la declaración de POST /admin/login');
  ok(/requireSameOrigin/.test(loginDeclMatch[0]), 'POST /admin/login tiene requireSameOrigin wireado');
}

// =======================================================================
async function main() {
  console.log('P0-SECURITY-01 - same-origin EXACTO: matriz A-I (lógica pura)');
  checkExactOriginMatrix();
  console.log('P0-SECURITY-01 - computeExpectedOrigin(): autoridad BASE_URL/PUBLIC_BASE_URL');
  checkComputeExpectedOrigin();
  console.log('P0-SECURITY-01 - same-origin EXACTO: integración HTTP real sobre POST /admin/login');
  await checkHttpIntegration();
  console.log('P0-SECURITY-01 - same-origin: fallback de desarrollo (sin BASE_URL) sigue funcionando');
  await checkDevFallbackStillWorks();
  console.log('P0-SECURITY-01 - same-origin: nunca substring matching (comprobación de fuente)');
  checkSourceNeverUsesSubstringMatching();
  console.log(`OK: ${checks} comprobaciones de same-origin EXACTO (scheme+host+puerto).`);
}

main().catch((err) => { console.error('FALLO:', err); process.exit(1); });
