/*
  LITUM3D - Integration test OPCIONAL contra MySQL real (EUR-ONLY-01, sección 24).

  Verifica, contra un MySQL 8 real y desechable (Docker), la migración
  database/migrations/add_pedidos_currency.sql:
    1. schema base se aplica limpio;
    2. las migraciones (incluida la nueva) corren sin error;
    3. pedidos.currency existe tras la migración;
    4. es NULLABLE;
    5. un pedido histórico "ficticio" puede insertarse con currency=NULL
       sin fallar (compatibilidad con los 29 pedidos reales existentes);
    6. un pedido nuevo puede guardar currency='EUR';
    7. reejecutar run-migrations.js una segunda vez no falla (idempotencia).

  Reutiliza el helper fail-closed de scripts/check-checkout-finalization-mysql.js
  (assertSafeMigrationTarget/HOST_PORT/ROOT_PASSWORD/DB_NAME) -- NUNCA toca
  localhost:3306 ni ninguna base de datos real: crea, usa y destruye su
  propio contenedor MySQL 8 en un puerto no estándar.

  NO forma parte de `npm test` (requiere Docker). Uso:
  node scripts/check-pedidos-currency-mysql.js
*/
const { execSync } = require('child_process');
const path = require('path');
const mysql = require('mysql2/promise');
const {
  assertSafeMigrationTarget,
  HOST_PORT,
  ROOT_PASSWORD,
  DB_NAME
} = require('./check-checkout-finalization-mysql');

const CONTAINER_NAME = 'litum3d-eur-only-01-pedidos-currency-mysql';

function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: opts.silent ? 'pipe' : 'inherit', encoding: 'utf8', env: opts.env || process.env });
}
function shQuiet(cmd) {
  try { return execSync(cmd, { stdio: 'pipe', encoding: 'utf8' }); } catch (_) { return null; }
}
function dockerAvailable() {
  try { execSync('docker info', { stdio: 'pipe' }); return true; } catch (_) { return false; }
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
      await new Promise(r => setTimeout(r, 4000));
      if (await canConnect()) return true;
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  return false;
}

async function loadSchema() {
  const fs = require('fs');
  const schemaPath = path.join(__dirname, '..', 'database', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const conn = await mysql.createConnection({ host: '127.0.0.1', port: HOST_PORT, user: 'root', password: ROOT_PASSWORD, multipleStatements: true });
  try {
    await conn.query(sql);
  } finally {
    await conn.end();
  }
}

function runMigrations() {
  const migrationEnvOverrides = { DB_HOST: '127.0.0.1', DB_PORT: String(HOST_PORT), DB_USER: 'root', DB_PASSWORD: ROOT_PASSWORD, DB_NAME };
  assertSafeMigrationTarget(migrationEnvOverrides);
  sh(`node "${path.join(__dirname, 'run-migrations.js')}"`, { env: { ...process.env, ...migrationEnvOverrides } });
}

async function main() {
  if (!dockerAvailable()) {
    console.log('[SKIP] Docker no está disponible en este entorno. Este test de integración es opcional (EUR-ONLY-01 #24) y no bloquea npm test.');
    process.exit(0);
  }

  console.log('[pedidos-currency-it] Levantando contenedor MySQL 8 desechable...');
  shQuiet(`docker rm -f ${CONTAINER_NAME}`);
  sh(`docker run -d --name ${CONTAINER_NAME} -e MYSQL_ROOT_PASSWORD=${ROOT_PASSWORD} -p ${HOST_PORT}:3306 mysql:8.0`, { silent: true });

  try {
    console.log('[pedidos-currency-it] Esperando a que MySQL acepte conexiones...');
    const ready = await waitForMysqlReady();
    if (!ready) throw new Error('MySQL no llegó a estar listo en el tiempo esperado');

    console.log('[pedidos-currency-it] Aplicando database/schema.sql...');
    await loadSchema();

    console.log('[pedidos-currency-it] Aplicando migraciones (1ª pasada)...');
    runMigrations();

    const conn = await mysql.createConnection({ host: '127.0.0.1', port: HOST_PORT, user: 'root', password: ROOT_PASSWORD, database: DB_NAME });
    try {
      // 3/4. La columna existe y es nullable.
      const [cols] = await conn.query(
        `SELECT IS_NULLABLE, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, COLUMN_DEFAULT
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pedidos' AND COLUMN_NAME = 'currency'`
      );
      if (!cols.length) throw new Error('FALLO: pedidos.currency no existe tras la migración');
      const col = cols[0];
      if (col.IS_NULLABLE !== 'YES') throw new Error(`FALLO: pedidos.currency debe ser NULLABLE, IS_NULLABLE="${col.IS_NULLABLE}"`);
      if (col.COLUMN_DEFAULT !== null) throw new Error(`FALLO: pedidos.currency NO debe tener DEFAULT (evita relabelar históricos), encontrado "${col.COLUMN_DEFAULT}"`);
      console.log(`OK: pedidos.currency existe, nullable, sin DEFAULT (${col.DATA_TYPE}(${col.CHARACTER_MAXIMUM_LENGTH})).`);

      // 5. Un pedido "histórico" (currency NULL) debe poder insertarse sin fallar.
      const [histResult] = await conn.query(
        "INSERT INTO pedidos (estado_id, total, currency) VALUES (1, 42.00, NULL)"
      );
      const [histRow] = await conn.query('SELECT currency FROM pedidos WHERE id = ?', [histResult.insertId]);
      if (histRow[0].currency !== null) throw new Error('FALLO: el pedido histórico ficticio no quedó con currency=NULL');
      console.log('OK: un pedido histórico ficticio (currency=NULL) se inserta sin fallar.');

      // 6. Un pedido nuevo puede guardar EUR explícito.
      const [newResult] = await conn.query(
        "INSERT INTO pedidos (estado_id, total, currency) VALUES (1, 42.00, 'EUR')"
      );
      const [newRow] = await conn.query('SELECT currency FROM pedidos WHERE id = ?', [newResult.insertId]);
      if (newRow[0].currency !== 'EUR') throw new Error(`FALLO: se esperaba currency='EUR', se obtuvo "${newRow[0].currency}"`);
      console.log('OK: un pedido nuevo guarda currency=\'EUR\' explícitamente.');
    } finally {
      await conn.end();
    }

    // 7. Reejecutar el runner completo una segunda vez no debe fallar
    // (idempotencia de add_pedidos_currency.sql, mismo patrón que las demás
    // migraciones de columna preparatoria).
    console.log('[pedidos-currency-it] Reejecutando migraciones (2ª pasada, prueba de idempotencia)...');
    runMigrations();
    console.log('OK: reejecutar las migraciones (incluida add_pedidos_currency.sql) no falla.');

    console.log('\nOK: integration test de pedidos.currency completado.');
  } finally {
    console.log('[pedidos-currency-it] Eliminando contenedor desechable...');
    shQuiet(`docker rm -f ${CONTAINER_NAME}`);
  }
}

main().catch(err => {
  console.error('FALLO:', err.message);
  shQuiet(`docker rm -f ${CONTAINER_NAME}`);
  process.exit(1);
});
