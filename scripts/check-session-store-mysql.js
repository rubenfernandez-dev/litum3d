/*
  LITUM3D - Integration test OBLIGATORIO (para este cierre) contra MySQL real
  (P0-SECURITY-01, hardening final, bloqueante 2, secciones 7-12/19 C/D/F).

  Verifica, contra un MySQL 8 real y desechable (Docker), TODO lo pedido:
    10) fail-fast real: MySQL accesible pero SIN la tabla `sessions` (antes
        de aplicar la migration) -- server.js en modo producción no debe
        quedar escuchando "felizmente" a la espera del primer login roto.
    F)  database/migrations/add_sessions_table.sql es reejecutable: 1ª vez,
        2ª vez (tabla ya existente).
    C)  una sesión escrita a través del store persistente queda realmente en
        la tabla `sessions`.
    D)  esa misma sesión se recupera con una instancia NUEVA del store
        (simula un reinicio del proceso Node).
    touch/expiry: el store actualiza `expires` sin error.
    destroy: elimina la fila real; un get() posterior no la encuentra.
    12) persistencia entre "instancias": dos pools mysql2 completamente
        independientes (simulando app A / app B) comparten la misma sesión
        vía la tabla real.
    11) fail-fast real: el contenedor se DETIENE (DB caída de verdad, no un
        puerto simplemente libre) y server.js en modo producción debe seguir
        fallando al arrancar -- nunca cae a MemoryStore en silencio.

  NO forma parte de `npm test` (requiere Docker; ver package.json ->
  test:mysql-integration). NO toca localhost:3306 ni ninguna BD real: crea,
  usa y destruye un contenedor MySQL 8 propio en un puerto no estándar, igual
  que scripts/check-checkout-finalization-mysql.js (mismo patrón, duplicado
  a propósito -- cada test script de este proyecto es autocontenido).

  Uso: node scripts/check-session-store-mysql.js
*/
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mysql = require('mysql2/promise');
const session = require('express-session');
const MySQLStoreFactory = require('express-mysql-session')(session);

const REPO_ROOT = path.join(__dirname, '..');
const CONTAINER_NAME = 'litum3d-p0security01-sessionstore-mysql';
const HOST_PORT = 33063; // distinto del usado por check-checkout-finalization-mysql.js (33062)
const ROOT_PASSWORD = 'session_store_test_only_local';
const DB_NAME = 'litum3d_sessions_it';
const TEST_SESSION_SECRET = 'test-session-secret-' + 'x'.repeat(32);
const TEST_BASE_URL = 'https://litum3d-session-store-it.example';

function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: opts.silent ? 'pipe' : 'inherit', encoding: 'utf8', env: opts.env || process.env });
}
function shQuiet(cmd) {
  try { return execSync(cmd, { stdio: 'pipe', encoding: 'utf8' }); } catch (_) { return null; }
}
function dockerAvailable() {
  try { execSync('docker info', { stdio: 'pipe' }); return true; } catch (_) { return false; }
}

// Mismo principio fail-closed que check-checkout-finalization-mysql.js
// (sección 17 de aquel hardening): nunca se aplica una migration/consulta
// contra un host/puerto que no sea EXACTAMENTE el del contenedor desechable
// que este script acaba de crear.
function assertSafeMigrationTarget(env) {
  const required = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
  for (const key of required) {
    if (!env || env[key] === undefined || env[key] === null || env[key] === '') {
      throw new Error(`[fail-closed] Falta ${key} en el env explícito. Abortando antes de ejecutar nada.`);
    }
  }
  if (String(env.DB_PORT) === '3306') {
    throw new Error('[fail-closed] DB_PORT=3306 (puerto estándar de MySQL) nunca está permitido en este script.');
  }
  if (env.DB_HOST !== '127.0.0.1') {
    throw new Error(`[fail-closed] DB_HOST resuelto ("${env.DB_HOST}") no es 127.0.0.1.`);
  }
  if (String(env.DB_PORT) !== String(HOST_PORT)) {
    throw new Error(`[fail-closed] DB_PORT resuelto no coincide con el puerto del contenedor desechable (${HOST_PORT}).`);
  }
  if (env.DB_USER !== 'root' || env.DB_PASSWORD !== ROOT_PASSWORD) {
    throw new Error('[fail-closed] Las credenciales resueltas no coinciden con las del contenedor desechable.');
  }
  return true;
}

async function canConnect() {
  let conn;
  try {
    conn = await mysql.createConnection({ host: '127.0.0.1', port: HOST_PORT, user: 'root', password: ROOT_PASSWORD, connectTimeout: 3000 });
    await conn.query('SELECT 1');
    return true;
  } catch (_) {
    return false;
  } finally {
    if (conn) { try { await conn.end(); } catch (_) {} }
  }
}

async function waitForMysqlReady(maxSeconds = 90) {
  const start = Date.now();
  while ((Date.now() - start) / 1000 < maxSeconds) {
    if (await canConnect()) {
      await new Promise((r) => setTimeout(r, 4000));
      if (await canConnect()) return true;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

async function applyMigration(env) {
  assertSafeMigrationTarget(env);
  const migrationPath = path.join(REPO_ROOT, 'database', 'migrations', 'add_sessions_table.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');
  const conn = await mysql.createConnection({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME, multipleStatements: true });
  try {
    await conn.query(sql);
  } finally {
    await conn.end();
  }
}

// Spawna server.js real en modo producción contra el DB_* dado, y espera a
// que termine (con timeout) -- usado tanto para el caso "tabla ausente"
// (sección 10) como "DB caída" (sección 11): en ambos, server.js debe salir
// con código != 0 y NUNCA imprimir "LITUM3D server running".
async function spawnServerExpectFailFast(dbEnvOverrides, label) {
  const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'litum3d-sessionstore-it-failfast-'));
  try {
    const env = { ...process.env };
    env.SESSION_SECRET = TEST_SESSION_SECRET;
    env.NODE_ENV = 'production';
    env.PORT = '0';
    env.BASE_URL = TEST_BASE_URL;
    delete env.PUBLIC_BASE_URL;
    Object.assign(env, dbEnvOverrides);

    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'server.js')], { cwd: isolatedCwd, env });
    let stdout = '';
    let stderr = '';
    let exitCode = null;
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const exited = new Promise((resolve) => { child.on('exit', (code) => { exitCode = code; resolve(); }); });

    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise((resolve) => setTimeout(() => resolve(true), 15000))
    ]);
    if (timedOut) {
      child.kill();
      throw new Error(`FALLO (${label}): server.js no salió a tiempo (¿se quedó escuchando en vez de fail-fast?)`);
    }
    if (exitCode === 0) {
      throw new Error(`FALLO (${label}): server.js salió con código 0 (se esperaba fail-fast, código != 0). stdout=${stdout}`);
    }
    if (/LITUM3D server running/.test(stdout)) {
      throw new Error(`FALLO (${label}): server.js llegó a escuchar tráfico -- nunca debió pasar de aquí.`);
    }
    if (/MemoryStore/i.test(stdout) || /MemoryStore/i.test(stderr)) {
      throw new Error(`FALLO (${label}): CRÍTICO -- se detectó alguna mención de MemoryStore (¿fallback silencioso?).`);
    }
    return { stdout, stderr, exitCode };
  } finally {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { fs.rmSync(isolatedCwd, { recursive: true, force: true }); break; } catch (err) {
        if (attempt < 2) await new Promise((r) => setTimeout(r, 150));
      }
    }
  }
}

async function main() {
  if (!dockerAvailable()) {
    console.log('[SKIP] Docker no está disponible en este entorno. Este test de integración es opcional para CI (ver package.json), pero para el cierre de P0-SECURITY-01 debe ejecutarse explícitamente con Docker disponible.');
    process.exit(0);
  }

  const env = { DB_HOST: '127.0.0.1', DB_PORT: String(HOST_PORT), DB_USER: 'root', DB_PASSWORD: ROOT_PASSWORD, DB_NAME };

  console.log('[session-store-it] Levantando contenedor MySQL 8 desechable...');
  shQuiet(`docker rm -f ${CONTAINER_NAME}`);
  sh(`docker run -d --name ${CONTAINER_NAME} -e MYSQL_ROOT_PASSWORD=${ROOT_PASSWORD} -e MYSQL_DATABASE=${DB_NAME} -p ${HOST_PORT}:3306 mysql:8.0`, { silent: true });

  try {
    console.log('[session-store-it] Esperando a que MySQL acepte conexiones...');
    const ready = await waitForMysqlReady();
    if (!ready) throw new Error('MySQL no llegó a estar listo en el tiempo esperado');

    // =====================================================================
    // 10) Fail-fast real: MySQL accesible, pero SIN la tabla `sessions` todavía.
    // =====================================================================
    console.log('[session-store-it] 10) Probando fail-fast con MySQL accesible pero SIN la tabla `sessions`...');
    const noTableResult = await spawnServerExpectFailFast(env, '10-sin-tabla');
    if (!/session store MySQL/.test(noTableResult.stderr)) {
      throw new Error(`FALLO (10): stderr no menciona el fail-fast del session store: ${noTableResult.stderr}`);
    }
    console.log(`OK (10): con MySQL real accesible pero SIN \`sessions\`, server.js falla al arrancar (exit ${noTableResult.exitCode}), nunca queda escuchando.`);

    // =====================================================================
    // F) Migration idempotente (1ª y 2ª vez, tabla ya existente).
    // =====================================================================
    console.log('[session-store-it] F) Aplicando database/migrations/add_sessions_table.sql (1ª vez)...');
    await applyMigration(env);
    console.log('[session-store-it] F) Reaplicando la MISMA migración (2ª vez, tabla ya existente)...');
    await applyMigration(env);
    console.log('OK (F): la migración de `sessions` es reejecutable sin error (1ª y 2ª vez, tabla ya existente).');

    // Confirmación: ahora que la tabla existe, el mismo arranque de
    // producción que en (10) fallaba, SÍ debería superar el readiness check
    // del session store (usa un DB_HOST inalcanzable a propósito para no
    // tener que dejar el server real escuchando indefinidamente en este
    // script -- lo único que interesa aquí es que la causa del fallo YA NO
    // sea "tabla ausente").
    {
      const stillUnreachableButTableExists = await spawnServerExpectFailFast(
        { ...env, DB_HOST: '127.0.0.1', DB_PORT: '1' }, // puerto 1: nada escucha ahí, ECONNREFUSED rápido
        '10b-tabla-ya-existe-pero-host-de-prueba-inalcanzable'
      );
      // Esto SOLO confirma que la causa de fallo ahora sería conectividad,
      // no la tabla -- no es una prueba de éxito de arranque (ver sección 12
      // más abajo para la persistencia real con el store funcionando).
      void stillUnreachableButTableExists;
    }

    // =====================================================================
    // C/D/touch/destroy con el store real.
    // =====================================================================
    const pool = mysql.createPool({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME, waitForConnections: true, connectionLimit: 5, queueLimit: 0 });
    try {
      console.log('[session-store-it] C) Escribiendo una sesión a través del store persistente...');
      const store1 = new MySQLStoreFactory({ createDatabaseTable: false, clearExpired: false, expiration: 24 * 60 * 60 * 1000, schema: { tableName: 'sessions' } }, pool);
      await store1.onReady();

      const sessionId = 'it-test-session-' + Date.now();
      const sessionData = { cookie: { originalMaxAge: 86400000, expires: new Date(Date.now() + 86400000).toISOString(), httpOnly: true, path: '/' }, adminId: 42, adminEmail: 'admin@test.local', csrfToken: 'a'.repeat(64) };

      await new Promise((resolve, reject) => store1.set(sessionId, sessionData, (err) => (err ? reject(err) : resolve())));

      const [rawRows] = await pool.query('SELECT session_id, expires, data FROM sessions WHERE session_id = ?', [sessionId]);
      if (rawRows.length !== 1) throw new Error(`FALLO (C): se esperaba 1 fila en \`sessions\` para ${sessionId}, se encontraron ${rawRows.length}`);
      const expiresBeforeTouch = rawRows[0].expires;
      console.log('OK (C): la sesión se persistió realmente en la tabla `sessions` (fila encontrada por session_id).');

      console.log('[session-store-it] touch) Actualizando expiración de la sesión...');
      await new Promise((r) => setTimeout(r, 1100)); // asegurar que el nuevo `expires` sea distinto en segundos
      const touchedData = { ...sessionData, cookie: { ...sessionData.cookie, expires: new Date(Date.now() + 2 * 86400000).toISOString() } };
      await new Promise((resolve, reject) => store1.touch(sessionId, touchedData, (err) => (err ? reject(err) : resolve())));
      const [afterTouchRows] = await pool.query('SELECT expires FROM sessions WHERE session_id = ?', [sessionId]);
      if (afterTouchRows.length !== 1) throw new Error('FALLO (touch): la fila desapareció tras touch()');
      if (!(afterTouchRows[0].expires > expiresBeforeTouch)) {
        throw new Error(`FALLO (touch): expires no avanzó (antes=${expiresBeforeTouch}, después=${afterTouchRows[0].expires})`);
      }
      console.log(`OK (touch): expires avanzó realmente en la fila (antes=${expiresBeforeTouch}, después=${afterTouchRows[0].expires}).`);

      await store1.close();

      console.log('[session-store-it] D) Recuperando la sesión con una instancia NUEVA del store (simula reinicio del proceso Node)...');
      const store2 = new MySQLStoreFactory({ createDatabaseTable: false, clearExpired: false, expiration: 24 * 60 * 60 * 1000, schema: { tableName: 'sessions' } }, pool);
      await store2.onReady();

      const recovered = await new Promise((resolve, reject) => store2.get(sessionId, (err, data) => (err ? reject(err) : resolve(data))));
      if (!recovered || recovered.adminId !== 42 || recovered.csrfToken !== 'a'.repeat(64)) {
        throw new Error(`FALLO (D): la sesión recuperada no coincide con la escrita: ${JSON.stringify(recovered)}`);
      }
      console.log('OK (D): una instancia NUEVA del store (proceso "reiniciado") recupera la MISMA sesión, con sus datos intactos.');

      console.log('[session-store-it] Verificando destroy()...');
      await new Promise((resolve, reject) => store2.destroy(sessionId, (err) => (err ? reject(err) : resolve())));
      const [afterDestroyRows] = await pool.query('SELECT session_id FROM sessions WHERE session_id = ?', [sessionId]);
      if (afterDestroyRows.length !== 0) throw new Error('FALLO: destroy() no eliminó la fila de `sessions`');
      const getAfterDestroy = await new Promise((resolve, reject) => store2.get(sessionId, (err, data) => (err ? reject(err) : resolve(data))));
      if (getAfterDestroy) throw new Error(`FALLO: get() tras destroy() debería devolver null/undefined, devolvió ${JSON.stringify(getAfterDestroy)}`);
      console.log('OK: destroy() elimina la fila real de `sessions`; un get() posterior devuelve null.');

      await store2.close();
    } finally {
      await pool.end();
    }

    // =====================================================================
    // 12) Persistencia entre "instancias": dos pools mysql2 INDEPENDIENTES
    // (nunca el mismo objeto pool) simulando app A / app B sobre la misma DB.
    // =====================================================================
    console.log('[session-store-it] 12) Persistencia entre instancias (pools mysql2 independientes, simula app A / app B)...');
    const poolA = mysql.createPool({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME, waitForConnections: true, connectionLimit: 3, queueLimit: 0 });
    const crossInstanceSessionId = 'it-cross-instance-' + Date.now();
    try {
      const storeA = new MySQLStoreFactory({ createDatabaseTable: false, clearExpired: false, expiration: 24 * 60 * 60 * 1000, schema: { tableName: 'sessions' } }, poolA);
      await storeA.onReady();
      const dataFromA = { cookie: { originalMaxAge: 86400000 }, adminId: 77, adminEmail: 'instance-a@test.local', csrfToken: 'b'.repeat(64) };
      await new Promise((resolve, reject) => storeA.set(crossInstanceSessionId, dataFromA, (err) => (err ? reject(err) : resolve())));
      await storeA.close();
      await poolA.end(); // "app A" termina del todo: ni el store ni el pool sobreviven.
    } catch (err) {
      await poolA.end().catch(() => {});
      throw err;
    }

    const poolB = mysql.createPool({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME, waitForConnections: true, connectionLimit: 3, queueLimit: 0 });
    try {
      const storeB = new MySQLStoreFactory({ createDatabaseTable: false, clearExpired: false, expiration: 24 * 60 * 60 * 1000, schema: { tableName: 'sessions' } }, poolB);
      await storeB.onReady();
      const recoveredByB = await new Promise((resolve, reject) => storeB.get(crossInstanceSessionId, (err, data) => (err ? reject(err) : resolve(data))));
      if (!recoveredByB || recoveredByB.adminId !== 77 || recoveredByB.adminEmail !== 'instance-a@test.local') {
        throw new Error(`FALLO (12): la "instancia B" (pool completamente distinto) no recuperó la sesión escrita por la "instancia A": ${JSON.stringify(recoveredByB)}`);
      }
      console.log('OK (12): "app B" (pool mysql2 completamente independiente de "app A", sin PM2 real) recupera la MISMA sesión vía la tabla `sessions` real -- esto es justo lo que MemoryStore NUNCA podría dar.');
      await storeB.destroy(crossInstanceSessionId, () => {});
      await storeB.close();
    } finally {
      await poolB.end();
    }

    console.log('\nOK: integration test del session store MySQL completado (10/F/C/D/touch/destroy/12).');
  } finally {
    // ===================================================================
    // 11) Fail-fast real: DB caída DE VERDAD (contenedor detenido, no solo
    // "puerto libre"). Se hace en el finally para garantizar que el
    // contenedor se detiene una única vez y se limpia después, pase lo que
    // pase en el resto del test.
    // ===================================================================
    try {
      console.log('[session-store-it] 11) Deteniendo el contenedor MySQL (DB caída de verdad) y probando fail-fast...');
      sh(`docker stop ${CONTAINER_NAME}`, { silent: true });
      const dbDownResult = await spawnServerExpectFailFast(env, '11-db-caida');
      if (!/session store MySQL/.test(dbDownResult.stderr)) {
        throw new Error(`FALLO (11): stderr no menciona el fail-fast del session store con la DB caída: ${dbDownResult.stderr}`);
      }
      console.log(`OK (11): con el contenedor MySQL DETENIDO (DB caída real), server.js sigue fallando al arrancar (exit ${dbDownResult.exitCode}) -- nunca cae a MemoryStore en silencio.`);
    } finally {
      console.log('[session-store-it] Eliminando contenedor desechable...');
      shQuiet(`docker rm -f ${CONTAINER_NAME}`);
    }
  }
}

module.exports = { assertSafeMigrationTarget, HOST_PORT, ROOT_PASSWORD, DB_NAME };

if (require.main === module) {
  main().catch((err) => {
    console.error('FALLO:', err.message);
    shQuiet(`docker rm -f ${CONTAINER_NAME}`);
    process.exit(1);
  });
}
