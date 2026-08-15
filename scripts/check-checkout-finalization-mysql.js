/*
  LITUM3D - Integration test OPCIONAL contra MySQL real (P0E-B4A, sección 37).

  Verifica, contra un MySQL 8 real y desechable (Docker), que
  pedidos.stripe_payment_intent_id UNIQUE bloquea de verdad dos INSERT con
  el mismo PaymentIntent -- la garantía definitiva en la que se apoya
  services/checkout-finalization.js#finalizePaidCheckout. Los tests de
  scripts/check-checkout-finalization.js ya cubren la LÓGICA de
  orquestación con un pool falso; este script valida que el supuesto de
  fondo (la propia restricción de MySQL) es real, no solo asumido.

  NO forma parte de `npm test` (requiere Docker; ver package.json). NO
  toca localhost:3306 ni ninguna base de datos real: crea, usa y destruye
  un contenedor MySQL 8 propio en un puerto no estándar, igual que
  P0E-B4-PREFLIGHT.

  Nota de plataforma: la carga de schema.sql y la verificación SQL se
  hacen con mysql2/promise conectando directamente al puerto mapeado del
  contenedor, en vez de "docker exec mysql -e ...". child_process.execSync
  de Node usa cmd.exe por defecto en Windows (no bash), y el quoting de SQL
  multilínea con comillas simples/dobles no sobrevive ese shell de forma
  fiable; una conexión TCP directa evita el problema por completo.

  Uso: node scripts/check-checkout-finalization-mysql.js
*/
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const CONTAINER_NAME = 'litum3d-b4a-finalization-mysql';
const HOST_PORT = 33062;
const ROOT_PASSWORD = 'b4a_finalization_test_only_local';
const DB_NAME = 'litum3d';

function sh(cmd, opts = {}) {
  // IMPORTANTE: reenviar opts.env explícitamente. Perder este spread fue
  // justo el bug que hizo que un run-migrations.js "aislado" se ejecutara
  // contra la BD real de .env en vez del contenedor desechable (ver
  // incidente documentado en el informe P0E-B4A) -- process.env por sí
  // solo NUNCA debe ser lo que reciba este child process cuando se pasa un
  // env explícito con las credenciales del contenedor.
  return execSync(cmd, {
    stdio: opts.silent ? 'pipe' : 'inherit',
    encoding: 'utf8',
    env: opts.env || process.env
  });
}

function shQuiet(cmd) {
  try { return execSync(cmd, { stdio: 'pipe', encoding: 'utf8' }); } catch (_) { return null; }
}

function dockerAvailable() {
  try { execSync('docker info', { stdio: 'pipe' }); return true; } catch (_) { return false; }
}

// Protección "fail closed" (sección 17 del hardening P0E-B4A): valida el
// env EXACTO que se le va a pasar al runner de migraciones, justo antes de
// pasárselo. No basta con "arreglar" el bug de opts.env una vez -- si
// alguien vuelve a introducir un fallback a process.env en el futuro, esta
// comprobación debe abortar el script en vez de dejarlo caer silenciosamente
// contra la BD real de .env (que es exactamente lo que ocurrió en el
// incidente original).
//
// database/schema.sql crea literalmente una BD llamada "litum3d" (hardcoded,
// no parametrizable sin tocar ese archivo, fuera de alcance aquí), así que
// el nombre de la BD NO puede ser la señal de seguridad -- el contenedor
// desechable usa el MISMO nombre que la BD real. La señal real e
// inequívoca es host+puerto: deben coincidir EXACTAMENTE con las constantes
// de ESTE script (127.0.0.1 y el puerto no estándar del contenedor que
// este mismo script acaba de crear), nunca con el puerto estándar 3306.
function assertSafeMigrationTarget(env) {
  const required = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
  for (const key of required) {
    if (!env || env[key] === undefined || env[key] === null || env[key] === '') {
      throw new Error(`[fail-closed] Falta ${key} en el env explícito para run-migrations.js. Abortando antes de ejecutar nada.`);
    }
  }
  if (String(env.DB_PORT) === '3306') {
    throw new Error('[fail-closed] DB_PORT=3306 (puerto estándar de MySQL) nunca está permitido en este script, bajo ninguna circunstancia.');
  }
  if (env.DB_HOST !== '127.0.0.1') {
    throw new Error(`[fail-closed] DB_HOST resuelto ("${env.DB_HOST}") no es 127.0.0.1. Este script solo puede apuntar al contenedor desechable que él mismo crea.`);
  }
  if (String(env.DB_PORT) !== String(HOST_PORT)) {
    throw new Error(`[fail-closed] DB_PORT resuelto ("${env.DB_PORT}") no coincide con el puerto del contenedor desechable de este script (${HOST_PORT}).`);
  }
  if (env.DB_USER !== 'root' || env.DB_PASSWORD !== ROOT_PASSWORD) {
    throw new Error('[fail-closed] Las credenciales resueltas no coinciden con las del contenedor desechable creado por este mismo script.');
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

// La imagen oficial de mysql arranca un servidor "temporal" para el
// bootstrap inicial, lo apaga y arranca el servidor real -- una única
// conexión exitosa puede caer justo en esa ventana temporal. Se exigen dos
// confirmaciones separadas por unos segundos para no seguir contra un
// servidor que está a punto de reiniciarse.
async function waitForMysqlReady(maxSeconds = 90) {
  const start = Date.now();
  while ((Date.now() - start) / 1000 < maxSeconds) {
    if (await canConnect()) {
      await new Promise(r => setTimeout(r, 4000));
      if (await canConnect()) return true;
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  return false;
}

async function loadSchema() {
  const schemaPath = path.join(__dirname, '..', 'database', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  // multipleStatements:true + el contenido íntegro del archivo: MySQL
  // parsea nativamente los comentarios `--`/bloque y los `;` de separación,
  // sin pasar por ningún splitter propio (evita el bug de scripts/init-db.js
  // documentado en P0E-B4-PREFLIGHT, que solo afecta a SU splitter en Node,
  // no a MySQL en sí).
  const conn = await mysql.createConnection({
    host: '127.0.0.1', port: HOST_PORT, user: 'root', password: ROOT_PASSWORD, multipleStatements: true
  });
  try {
    await conn.query(sql);
  } finally {
    await conn.end();
  }
}

async function main() {
  if (!dockerAvailable()) {
    console.log('[SKIP] Docker no está disponible en este entorno. Este test de integración es opcional (ver P0E-B4A #37/#40) y no bloquea npm test.');
    process.exit(0);
  }

  console.log('[mysql-it] Levantando contenedor MySQL 8 desechable...');
  shQuiet(`docker rm -f ${CONTAINER_NAME}`);
  sh(`docker run -d --name ${CONTAINER_NAME} -e MYSQL_ROOT_PASSWORD=${ROOT_PASSWORD} -p ${HOST_PORT}:3306 mysql:8.0`, { silent: true });

  try {
    console.log('[mysql-it] Esperando a que MySQL acepte conexiones...');
    const ready = await waitForMysqlReady();
    if (!ready) throw new Error('MySQL no llegó a estar listo en el tiempo esperado');

    console.log('[mysql-it] Aplicando database/schema.sql...');
    await loadSchema();

    console.log('[mysql-it] Aplicando migraciones (scripts/run-migrations.js)...');
    const migrationEnvOverrides = { DB_HOST: '127.0.0.1', DB_PORT: String(HOST_PORT), DB_USER: 'root', DB_PASSWORD: ROOT_PASSWORD, DB_NAME };
    assertSafeMigrationTarget(migrationEnvOverrides);
    sh(`node "${path.join(__dirname, 'run-migrations.js')}"`, {
      silent: false,
      env: { ...process.env, ...migrationEnvOverrides }
    });

    console.log('[mysql-it] Verificando la restricción UNIQUE real de pedidos.stripe_payment_intent_id...');

    const conn = await mysql.createConnection({ host: '127.0.0.1', port: HOST_PORT, user: 'root', password: ROOT_PASSWORD, database: DB_NAME });
    try {
      await conn.query(
        "INSERT INTO pedidos (estado_id, total, stripe_payment_intent_id) VALUES (1, 65.00, 'pi_integration_test_A')"
      );

      let secondInsertRejected = false;
      let rejectionErr = null;
      try {
        await conn.query(
          "INSERT INTO pedidos (estado_id, total, stripe_payment_intent_id) VALUES (1, 65.00, 'pi_integration_test_A')"
        );
      } catch (err) {
        secondInsertRejected = err.code === 'ER_DUP_ENTRY';
        rejectionErr = err;
      }

      if (!secondInsertRejected) {
        throw new Error(
          'FALLO: MySQL real permitió dos pedidos con el mismo stripe_payment_intent_id (la constraint UNIQUE no está funcionando)' +
          (rejectionErr ? ` [error visto: ${rejectionErr.code || rejectionErr.message}]` : ' [ningún error, el INSERT se aceptó]')
        );
      }
      console.log(`OK: MySQL real rechaza dos INSERT en pedidos con el mismo stripe_payment_intent_id (${rejectionErr.sqlMessage}).`);

      const [rows] = await conn.query(
        "SELECT COUNT(*) AS n FROM pedidos WHERE stripe_payment_intent_id = 'pi_integration_test_A'"
      );
      if (rows[0].n !== 1) {
        throw new Error(`FALLO: se esperaba exactamente 1 fila con ese PaymentIntent, se encontraron ${rows[0].n}`);
      }
      console.log('OK: exactamente 1 fila persistida para ese PaymentIntent (el segundo INSERT no dejó rastro parcial).');
    } finally {
      await conn.end();
    }

    console.log('\nOK: integration test MySQL real completado.');
  } finally {
    console.log('[mysql-it] Eliminando contenedor desechable...');
    shQuiet(`docker rm -f ${CONTAINER_NAME}`);
  }
}

module.exports = { assertSafeMigrationTarget, HOST_PORT, ROOT_PASSWORD, DB_NAME };

// Solo se ejecuta como script (node scripts/check-checkout-finalization-mysql.js),
// nunca al hacer require() desde un test -- así assertSafeMigrationTarget es
// testeable sin Docker (ver scripts/check-checkout-finalization-mysql-guard.js).
if (require.main === module) {
  main().catch(err => {
    console.error('FALLO:', err.message);
    shQuiet(`docker rm -f ${CONTAINER_NAME}`);
    process.exit(1);
  });
}
