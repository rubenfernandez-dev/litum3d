/*
  LITUM3D - P0-SECURITY-01 (hardening final, secciones 4-10, 19 A/B/E):
  session store de producción.

  Cubre, SIN Docker ni BD real:
    A) en producción, buildSessionStore() no puede terminar usando MemoryStore
       -- createProductionSessionStore() devuelve una instancia MySQLStore
       real, con createDatabaseTable:false (la tabla la crea la migration,
       nunca la librería "mágicamente").
    B) si la tabla `sessions`/MySQL no es alcanzable en producción, server.js
       falla al arrancar (fail-fast) -- spawn real, nunca llega a escuchar.
    E) expiración configurable: coincide con SESSION_MAX_AGE_MS (24h) y la
       purga de expiradas está activada con un intervalo acotado (nunca
       retención infinita).

  La integración REAL contra un MySQL vivo (escribir/leer una sesión,
  reejecutar la migration) vive en scripts/check-session-store-mysql.js
  (opcional, requiere Docker, fuera de `npm test`).

  Uso: node scripts/check-session-store.js
*/
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const session = require('express-session');

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); checks++; }

const REPO_ROOT = path.join(__dirname, '..');
const TEST_SESSION_SECRET = 'test-session-secret-' + 'x'.repeat(32);

// =======================================================================
// A) createProductionSessionStore(): MySQLStore real, nunca MemoryStore
// =======================================================================
async function checkProductionStoreIsNotMemoryStore() {
  const { createProductionSessionStore, SESSION_MAX_AGE_MS } = require('../config/sessionStore');
  const store = createProductionSessionStore();
  try {
    ok(store instanceof session.Store, 'createProductionSessionStore() devuelve una instancia de session.Store real');
    ok(!(store instanceof session.MemoryStore), 'CRÍTICO: el store de producción NUNCA es session.MemoryStore');
    eq(store.options.createDatabaseTable, false, 'createDatabaseTable:false -- la tabla la crea la migration explícita, nunca la librería');
    eq(store.options.schema.tableName, 'sessions', 'usa la tabla `sessions` de la migration (database/migrations/add_sessions_table.sql)');

    // E) expiración configurable, purga de expiradas acotada.
    eq(store.options.expiration, SESSION_MAX_AGE_MS, 'expiration del store coincide con SESSION_MAX_AGE_MS (24h, mismo valor que cookie.maxAge)');
    eq(store.options.clearExpired, true, 'clearExpired:true -- las sesiones expiradas SÍ se purgan (sin retención infinita)');
    ok(typeof store.options.checkExpirationInterval === 'number' && store.options.checkExpirationInterval > 0 && store.options.checkExpirationInterval <= 60 * 60 * 1000, 'checkExpirationInterval es un intervalo acotado (<=1h), no 0/infinito');

    // El constructor inicializa el store de forma ASÍNCRONA (createDatabaseTable
    // check -> state=INITIALIZED -> setExpirationInterval() si clearExpired).
    // Hay que esperar a que ese setInterval() real llegue a crearse ANTES de
    // cerrarlo -- si se llama a close() demasiado pronto (síncronamente tras
    // el constructor), clearInterval() se ejecuta sobre `undefined` (el
    // interno todavía no existe) y el setInterval sobrevive, dejando el
    // proceso de test vivo hasta 15 minutos.
    await store.onReady();
  } finally {
    // Libera el setInterval interno del store sin cerrar el pool compartido
    // (el store recibió el pool YA existente como conexión externa, así que
    // close() no debe terminarlo -- ver config/sessionStore.js).
    await store.close();
  }
}

// =======================================================================
// B) Fail-fast real: producción + tabla `sessions`/MySQL inalcanzable
// =======================================================================
async function findFreeLocalPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function checkFailFastWhenSessionsTableUnreachable() {
  const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'litum3d-sessionstore-failfast-'));
  try {
    // Puerto local libre justo antes del spawn: nada escucha ahí ->
    // ECONNREFUSED rápido y determinista (en vez de un timeout largo contra
    // un host no enrutable).
    const deadPort = await findFreeLocalPort();

    const env = { ...process.env };
    env.SESSION_SECRET = TEST_SESSION_SECRET;
    env.NODE_ENV = 'production';
    env.PORT = '0';
    // BASE_URL válida (P0-SECURITY-01 cierre final, bloqueante 1): en
    // producción server.js también hace fail-fast si falta -- este test
    // quiere aislar específicamente el fail-fast del SESSION STORE, así que
    // se fija un valor válido para no disparar el otro guard primero.
    env.BASE_URL = 'https://litum3d-session-store-test.example';
    delete env.PUBLIC_BASE_URL;
    env.DB_HOST = '127.0.0.1';
    env.DB_PORT = String(deadPort);
    env.DB_USER = 'nonexistent_user';
    env.DB_PASSWORD = 'x';
    env.DB_NAME = 'litum3d_test_unreachable';

    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'server.js')], { cwd: isolatedCwd, env });
    let stdout = '';
    let stderr = '';
    let exitCode = null;
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const exited = new Promise((resolve) => { child.on('exit', (code) => { exitCode = code; resolve(); }); });

    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise((resolve) => setTimeout(() => resolve(true), 8000))
    ]);

    if (timedOut) {
      child.kill();
      throw new Error('server.js no salió en producción con la tabla `sessions` inalcanzable (¿se quedó colgado en vez de fail-fast?)');
    }

    ok(exitCode !== 0, 'CRÍTICO: producción con MySQL/tabla `sessions` inalcanzable -> server.js sale con código != 0 (fail-fast)');
    ok(/session store MySQL/.test(stderr), 'el mensaje de error en stderr identifica el problema (session store MySQL)');
    ok(!/LITUM3D server running/.test(stdout), 'CRÍTICO: nunca llega a escuchar ni aceptar tráfico');
    ok(!/MemoryStore/i.test(stderr) && !/MemoryStore/i.test(stdout), 'nunca menciona un fallback a MemoryStore (no existe tal fallback)');
  } finally {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { fs.rmSync(isolatedCwd, { recursive: true, force: true }); break; } catch (err) {
        if (attempt === 2) console.warn(`[check-session-store] no se pudo limpiar ${isolatedCwd} (${err.code})`);
        else await new Promise((r) => setTimeout(r, 150));
      }
    }
  }
}

// =======================================================================
// Comprobación de fuente: la rama de producción nunca "traga" el error y
// sigue adelante -- debe contener process.exit(1) dentro del catch.
// =======================================================================
function checkSourceNeverSilentlyFallsBack() {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf8');
  const buildFnMatch = src.match(/async function buildSessionStore\(\)[\s\S]*?\n}/);
  ok(buildFnMatch, 'se localizó buildSessionStore() en server.js');
  const fnSrc = buildFnMatch[0];
  ok(/catch\s*\(err\)\s*\{[\s\S]*?process\.exit\(1\)/.test(fnSrc), 'CRÍTICO: el catch de la verificación de `sessions` en producción termina en process.exit(1), nunca continúa');
  ok(!/new\s+(session\.)?MemoryStore/.test(fnSrc), 'buildSessionStore() nunca instancia MemoryStore explícitamente (undefined -> lo asigna express-session por defecto solo fuera de producción)');
}

// =======================================================================
async function main() {
  console.log('P0-SECURITY-01 - session store de producción: MySQLStore real, nunca MemoryStore (A/E)');
  await checkProductionStoreIsNotMemoryStore();
  console.log('P0-SECURITY-01 - producción nunca cae en fallback silencioso (comprobación de fuente)');
  checkSourceNeverSilentlyFallsBack();
  console.log('P0-SECURITY-01 - fail-fast real: producción + tabla `sessions` inalcanzable (B)');
  await checkFailFastWhenSessionsTableUnreachable();
  console.log(`OK: ${checks} comprobaciones sobre el session store de producción.`);
}

main().catch((err) => { console.error('FALLO:', err); process.exit(1); });
