/*
  LITUM3D - P0-SECURITY-01: sesión, cookies, login, logout, session fixation.

  Cubre:
    A) SESSION_SECRET fail-closed: server.js se niega a arrancar sin él, sin
       imprimir ningún secreto; con él, arranca con normalidad.
    B) Configuración de cookie (httpOnly/secure/sameSite/saveUninitialized/
       resave) fijada explícitamente en server.js -- comprobación de fuente,
       ya que requiere un servidor real escuchando para inspeccionar
       Set-Cookie de extremo a extremo (cubierto también en C/D).
    C) Login: session fixation (regenerate), mensaje genérico en fallo (email
       inexistente y contraseña incorrecta dan la MISMA respuesta), sin
       Set-Cookie en login fallido.
    D) Logout: destruye la sesión server-side y limpia la cookie; la MISMA
       cookie deja de autenticar después. Cookie manipulada -> nunca autentica.

  No usa una base de datos real: inyecta un pool falso vía manipulación del
  cache de require('../config/db'), mismo patrón que scripts/check-uploads-privacy.js.
  Usa un servidor HTTP real (app.listen(0)) + fetch, para ejercitar
  express-session de verdad (no una simulación).

  Uso: node scripts/check-session-security.js
*/
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); checks++; }

// BASE_URL fija ANTES de cualquier require de routes/admin.js (y, por tanto,
// de middleware/sameOrigin.js -- ver P0-SECURITY-01 cierre final,
// bloqueante 1): el singleton EXPECTED_ORIGIN de ese módulo se calcula una
// única vez al cargarse, así que este test envía Origin: LOGIN_TEST_ORIGIN
// en sus peticiones de login en vez de intentar hacer coincidir el puerto
// efímero real del servidor de test (que ya no es la autoridad -- la
// autoridad es BASE_URL, nunca el host de la propia petición). La matriz
// completa de same-origin EXACTO vive en scripts/check-login-origin.js; aquí
// solo se necesita UNA petición same-origin válida para probar
// regenerate/logout/etc.
const LOGIN_TEST_ORIGIN = 'http://litum3d-session-security-test.local';
process.env.BASE_URL = LOGIN_TEST_ORIGIN;
delete process.env.PUBLIC_BASE_URL;

const TEST_SESSION_SECRET = 'test-session-secret-' + 'x'.repeat(32);
const REPO_ROOT = path.join(__dirname, '..');

// =======================================================================
// A) SESSION_SECRET fail-closed (spawn real server.js)
// =======================================================================
function checkSessionSecretFailClosed() {
  // cwd aislado sin .env propio: si dotenv encontrara un .env real (el del
  // proyecto) podría rellenar SESSION_SECRET que borramos abajo y falsear el
  // test. require() de módulos sigue resolviendo por ruta absoluta de
  // server.js, así que el cwd no afecta la carga de código, solo dotenv.
  const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'litum3d-failclosed-'));
  try {
    const env = { ...process.env };
    delete env.SESSION_SECRET;
    env.NODE_ENV = 'test';
    env.PORT = '0';

    const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'server.js')], {
      cwd: isolatedCwd,
      env,
      timeout: 5000,
      encoding: 'utf8'
    });

    ok(result.status !== 0, 'server.js sin SESSION_SECRET sale con código != 0 (fail-fast)');
    ok(/SESSION_SECRET/.test(result.stderr || ''), 'el mensaje de error en stderr menciona SESSION_SECRET');
    ok(!/LITUM3D server running/.test(result.stdout || ''), 'CRÍTICO: el servidor nunca llega a escuchar sin SESSION_SECRET');
    // Nunca debe haber un fallback fijo tipo 'please-configure-...' en el código.
    const serverSrc = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf8');
    ok(!/secret:\s*process\.env\.SESSION_SECRET\s*\|\|/.test(serverSrc), 'server.js ya no usa `process.env.SESSION_SECRET || \'...\'` (sin fallback inseguro)');
    ok(!serverSrc.includes('please-configure-session-secret-in-production'), 'el fallback fijo antiguo ya no existe en el código fuente');
  } finally {
    fs.rmSync(isolatedCwd, { recursive: true, force: true });
  }
}

// Con SESSION_SECRET configurado, el servidor SÍ arranca (no depende de DB real).
async function checkServerStartsWithSessionSecret() {
  const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'litum3d-bootok-'));
  try {
    const env = { ...process.env };
    env.SESSION_SECRET = TEST_SESSION_SECRET;
    env.NODE_ENV = 'test';
    env.PORT = '0';
    // DB_* deliberadamente sin configurar / apuntando a nada real: arrancar
    // no debe depender de que MySQL esté disponible (solo /health lo usaría).

    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'server.js')], { cwd: isolatedCwd, env });
    let stdout = '';
    let exited = false;
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('exit', () => { exited = true; });

    const started = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 4000);
      const iv = setInterval(() => {
        if (stdout.includes('LITUM3D server running')) {
          clearTimeout(timer); clearInterval(iv); resolve(true);
        }
        if (exited) { clearTimeout(timer); clearInterval(iv); resolve(false); }
      }, 50);
    });

    ok(started, 'con SESSION_SECRET configurado, el servidor SÍ arranca y escucha (no depende de que MySQL esté disponible)');

    // Esperar la salida REAL del proceso antes de borrar isolatedCwd: en
    // Windows, el directorio de trabajo de un proceso hijo queda con un
    // handle abierto hasta que el proceso termina de verdad (no basta con
    // haber llamado a kill()), y un rmSync inmediato falla con EBUSY.
    if (!exited) {
      child.kill();
      await new Promise((resolve) => {
        if (exited) return resolve();
        child.once('exit', resolve);
        setTimeout(resolve, 2000); // red de seguridad: no bloquear el test indefinidamente
      });
    }
  } finally {
    // Reintento best-effort: si el handle todavía no se liberó (SO lento),
    // no se cae el test por un directorio temporal que el propio SO limpiará.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.rmSync(isolatedCwd, { recursive: true, force: true });
        break;
      } catch (err) {
        if (attempt === 2) {
          console.warn(`[check-session-security] no se pudo limpiar ${isolatedCwd} (${err.code}) -- se dejará para el SO`);
        } else {
          await new Promise((r) => setTimeout(r, 150));
        }
      }
    }
  }
}

// =======================================================================
// B) Cookie/session config fijada explícitamente (comprobación de fuente)
// =======================================================================
function checkCookieConfigInSource() {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf8');
  ok(/httpOnly:\s*true/.test(src), 'cookie.httpOnly: true fijado explícitamente');
  ok(/sameSite:\s*['"]lax['"]/.test(src), "cookie.sameSite: 'lax' fijado explícitamente");
  ok(/secure:\s*process\.env\.NODE_ENV === ['"]production['"]/.test(src), 'cookie.secure depende de NODE_ENV===production (no true a ciegas, no siempre false)');
  ok(/saveUninitialized:\s*false/.test(src), 'saveUninitialized: false (no crea sesión para cada visitante anónimo)');
  ok(/resave:\s*false/.test(src), 'resave: false');
  ok(/app\.set\(\s*['"]trust proxy['"]/.test(src), "trust proxy configurado explícitamente (sección 6)");
  ok(/maxAge/.test(src), 'maxAge de cookie configurado explícitamente');

  // requireAuth.js nunca debe loguear cookies/sessionID/tokens (sección 41).
  const requireAuthSrc = fs.readFileSync(path.join(REPO_ROOT, 'middleware', 'requireAuth.js'), 'utf8');
  ok(!/req\.headers\.cookie/.test(requireAuthSrc), 'requireAuth.js ya no loguea req.headers.cookie');
  ok(!/req\.sessionID/.test(requireAuthSrc), 'requireAuth.js ya no loguea req.sessionID');
}

// =======================================================================
// Infraestructura común para C/D: servidor real con express-session real +
// routes/admin.js real + pool de BD falso.
// =======================================================================
function installFakeDbModule(fakePool) {
  const dbPath = require.resolve('../config/db');
  const original = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: fakePool } };
  return () => { if (original) require.cache[dbPath] = original; else delete require.cache[dbPath]; };
}

function loadFreshAdminRouter(fakePool) {
  const restore = installFakeDbModule(fakePool);
  const adminPath = require.resolve('../routes/admin');
  delete require.cache[adminPath];
  const router = require('../routes/admin');
  restore();
  delete require.cache[adminPath];
  return router;
}

async function buildTestServer(fakePool) {
  const adminRouter = loadFreshAdminRouter(fakePool);
  const app = express();
  app.use(express.json());
  app.use(session({
    secret: TEST_SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 60 * 1000 }
  }));
  app.use('/admin', adminRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return server;
}

function sessionCookieFrom(setCookieHeader) {
  ok(!!setCookieHeader, 'la respuesta incluye Set-Cookie');
  return setCookieHeader.split(';')[0];
}

// =======================================================================
// C) Login: session fixation, mensajes genéricos, sin Set-Cookie en fallo
// =======================================================================
async function checkLoginBehavior() {
  const plainPassword = 'CorrectHorseBatteryStaple!1';
  const adminRow = {
    id: 7,
    email: 'admin@test.local',
    nombre: 'Test Admin',
    contraseña: await bcrypt.hash(plainPassword, 10)
  };
  const fakePool = {
    async query(sql, params = []) {
      if (sql.includes('FROM usuarios WHERE email')) {
        return [params[0] === adminRow.email ? [adminRow] : []];
      }
      throw new Error('Fake pool (login): consulta no reconocida: ' + sql);
    }
  };

  const server = await buildTestServer(fakePool);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // Session fixation: se envía un ID de sesión "fijado por un atacante"
    // ANTES del login (firmado con el mismo secreto de test, formato real de
    // express-session/cookie-signature), y se comprueba que el ID tras un
    // login exitoso es DISTINTO.
    const signature = require(path.join(REPO_ROOT, 'node_modules', 'cookie-signature'));
    const attackerSid = 'attacker-fixed-session-id-0000000000';
    const attackerCookieValue = 's:' + signature.sign(attackerSid, TEST_SESSION_SECRET);
    const attackerCookieHeader = `connect.sid=${encodeURIComponent(attackerCookieValue)}`;

    const loginRes = await fetch(`${base}/admin/login`, {
      method: 'POST',
      // Origin same-origin (sección 12 del hardening final): sin esto,
      // requireSameOrigin rechazaría la petición con 403 antes de llegar
      // aquí -- fetch() de Node no añade Origin automáticamente como sí
      // hace un navegador real (ver scripts/check-login-origin.js para la
      // matriz completa de esa protección).
      headers: { 'Content-Type': 'application/json', 'Cookie': attackerCookieHeader, 'Origin': LOGIN_TEST_ORIGIN },
      body: JSON.stringify({ email: adminRow.email, password: plainPassword })
    });
    eq(loginRes.status, 200, 'login con credenciales correctas -> 200');
    const loginBody = await loginRes.json();
    ok(loginBody.success === true, 'login exitoso responde success:true');

    const setCookie = loginRes.headers.get('set-cookie');
    const sessionCookie = sessionCookieFrom(setCookie);
    const rawValue = decodeURIComponent(sessionCookie.split('=').slice(1).join('='));
    ok(rawValue.startsWith('s:'), 'la cookie de sesión tras login está firmada (prefijo s:)');
    const newSid = rawValue.slice(2).split('.')[0];
    ok(newSid !== attackerSid, 'CRÍTICO (session fixation): el sessionID tras login NUNCA es el fijado por un atacante antes del login');

    // La nueva sesión SÍ es válida y autentica una ruta protegida.
    const csrfRes = await fetch(`${base}/admin/api/csrf-token`, { headers: { Cookie: sessionCookie } });
    eq(csrfRes.status, 200, 'con la cookie nueva tras login -> ruta autenticada 200');
    const { csrfToken } = await csrfRes.json();
    ok(typeof csrfToken === 'string' && csrfToken.length >= 32, 'el token CSRF entregado tiene entropía razonable');

    return { server, port, base, adminRow, plainPassword, sessionCookie, csrfToken };
  } catch (err) {
    await new Promise((r) => server.close(r));
    throw err;
  }
}

async function checkLoginFailureBehavior() {
  const plainPassword = 'CorrectHorseBatteryStaple!1';
  const adminRow = { id: 7, email: 'admin@test.local', nombre: 'Test Admin', contraseña: await bcrypt.hash(plainPassword, 10) };
  const fakePool = {
    async query(sql, params = []) {
      if (sql.includes('FROM usuarios WHERE email')) {
        return [params[0] === adminRow.email ? [adminRow] : []];
      }
      throw new Error('Fake pool (login-fail): consulta no reconocida: ' + sql);
    }
  };
  const server = await buildTestServer(fakePool);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    // Origin same-origin en ambas peticiones (sección 12 del hardening
    // final): sin esto, requireSameOrigin las rechazaría con 403 antes de
    // llegar al chequeo de credenciales que este test quiere ejercitar.
    const sameOriginHeader = LOGIN_TEST_ORIGIN;

    // Contraseña incorrecta.
    const wrongPassRes = await fetch(`${base}/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': sameOriginHeader },
      body: JSON.stringify({ email: adminRow.email, password: 'password-incorrecta' })
    });
    eq(wrongPassRes.status, 401, 'contraseña incorrecta -> 401');
    const wrongPassBody = await wrongPassRes.json();
    eq(wrongPassBody.error, 'Credenciales inválidas', 'mensaje genérico para contraseña incorrecta');
    ok(!wrongPassRes.headers.get('set-cookie'), 'login fallido (contraseña) NO establece ninguna sesión (sin Set-Cookie)');

    // Email inexistente -> MISMO mensaje (no revela si el usuario existe).
    const unknownEmailRes = await fetch(`${base}/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': sameOriginHeader },
      body: JSON.stringify({ email: 'no-existe@test.local', password: 'x' })
    });
    eq(unknownEmailRes.status, 401, 'email inexistente -> 401');
    const unknownEmailBody = await unknownEmailRes.json();
    eq(unknownEmailBody.error, wrongPassBody.error, 'CRÍTICO: email inexistente da el MISMO mensaje que contraseña incorrecta (no enumeración de usuarios)');
    ok(!unknownEmailRes.headers.get('set-cookie'), 'login fallido (email inexistente) tampoco establece sesión');
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// =======================================================================
// D) Logout: destrucción de sesión + limpieza de cookie + cookie manipulada
// =======================================================================
async function checkLogoutAndTamperedCookie() {
  const loginResult = await checkLoginBehavior();
  const { server, base, sessionCookie, csrfToken } = loginResult;
  try {
    // Cookie manipulada/no reconocida -> nunca autentica.
    const tamperedRes = await fetch(`${base}/admin/api/csrf-token`, { headers: { Cookie: 'connect.sid=totalmente-invalida-no-firmada' } });
    eq(tamperedRes.status, 401, 'cookie de sesión manipulada/no firmada -> 401 (nunca autentica)');

    // Logout sin CSRF -> rechazado (ver también check-csrf.js para la matriz completa).
    const logoutNoCsrf = await fetch(`${base}/admin/logout`, { method: 'POST', headers: { Cookie: sessionCookie } });
    eq(logoutNoCsrf.status, 403, 'logout sin token CSRF -> 403 (no se puede desloguear a nadie desde otro origen)');

    // Logout con sesión + CSRF válidos -> 200, limpia sesión y cookie.
    const logoutRes = await fetch(`${base}/admin/logout`, { method: 'POST', headers: { Cookie: sessionCookie, 'X-CSRF-Token': csrfToken } });
    eq(logoutRes.status, 200, 'logout con sesión+CSRF válidos -> 200');
    const logoutSetCookie = logoutRes.headers.get('set-cookie');
    ok(logoutSetCookie, 'logout responde con Set-Cookie (limpieza explícita en el navegador)');
    ok(/connect\.sid=;/.test(logoutSetCookie) || /connect\.sid=;\s*Max-Age=0/i.test(logoutSetCookie) || /Expires=Thu, 01 Jan 1970/i.test(logoutSetCookie), 'la cookie se limpia (valor vacío/expirado), sección 10');

    // La MISMA cookie usada antes del logout ya no autentica.
    const afterLogoutRes = await fetch(`${base}/admin/api/csrf-token`, { headers: { Cookie: sessionCookie } });
    eq(afterLogoutRes.status, 401, 'CRÍTICO: tras logout, la MISMA cookie de sesión ya NO autentica ninguna ruta protegida');
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// =======================================================================
async function main() {
  console.log('P0-SECURITY-01 - SESSION_SECRET fail-closed (spawn real de server.js)');
  checkSessionSecretFailClosed();
  console.log('P0-SECURITY-01 - server.js SÍ arranca con SESSION_SECRET configurado');
  await checkServerStartsWithSessionSecret();
  console.log('P0-SECURITY-01 - configuración de cookie/sesión fijada explícitamente en server.js');
  checkCookieConfigInSource();
  console.log('P0-SECURITY-01 - login: mensajes genéricos, sin Set-Cookie en fallo');
  await checkLoginFailureBehavior();
  console.log('P0-SECURITY-01 - logout: destruye sesión, limpia cookie, cookie manipulada nunca autentica');
  await checkLogoutAndTamperedCookie();
  console.log(`OK: ${checks} comprobaciones de sesión/cookies/login/logout.`);
}

main().catch((err) => { console.error('FALLO:', err); process.exit(1); });
