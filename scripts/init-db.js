/*
  LITUM3D - DB initializer
  - Reads database/schema.sql and executes statements on MySQL
  - Uses env vars: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD (DB_NAME optional; schema sets USE)
*/

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// Load .env if present
try { require('dotenv').config(); } catch (_) {}

const {
  DB_HOST = 'localhost',
  DB_PORT = 3306,
  DB_USER = 'root',
  DB_PASSWORD = '',
} = process.env;

async function run() {
  const sqlPath = path.join(__dirname, '..', 'database', 'schema.sql');
  if (!fs.existsSync(sqlPath)) {
    console.error(`[init-db] No se encontró el archivo: ${sqlPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(sqlPath, 'utf8');

  // Remove /* ... */ block comments and split by ';'
  const withoutBlockComments = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = withoutBlockComments
    .split('\n')
    .map(l => l.replace(/--.*$/, '')) // remove -- comments at end of line
    .join('\n');

  // Split by semicolon; keep order. This is a naive splitter but OK for this schema.
  const statements = lines
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  console.log(`[init-db] Total de sentencias a ejecutar: ${statements.length}`);

  let connection;
  try {
    connection = await mysql.createConnection({
      host: DB_HOST,
      port: Number(DB_PORT),
      user: DB_USER,
      password: DB_PASSWORD,
      multipleStatements: false
    });
  } catch (err) {
    console.error('[init-db] Error de conexión MySQL.');
    console.error(err.message);
    if (err.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error('Revisa las variables DB_USER y DB_PASSWORD.');
    }
    process.exit(1);
  }

  try {
    for (const [i, stmt] of statements.entries()) {
      try {
        // Skip empty or pure comments (already stripped, but safety)
        if (!stmt || /^\s*(--|#)/.test(stmt)) continue;

        // Use .query() (text protocol) to allow statements like USE
        await connection.query(stmt);
        // console.log(`[OK] ${stmt.substring(0, 60)}...`);
      } catch (err) {
        // Handle idempotency for common cases
        const code = err && err.code;
        const isDup = code === 'ER_DUP_ENTRY' || code === 'ER_DUP_KEY';
        const isDbExists = code === 'ER_DB_CREATE_EXISTS';
        const isTableExists = code === 'ER_TABLE_EXISTS_ERROR';

        if (isDup || isDbExists || isTableExists) {
          console.warn(`[skip:${code}] ${stmt.substring(0, 60)}...`);
          continue;
        }

        console.error(`\n[init-db] Error en sentencia #${i + 1}:`);
        console.error(stmt);
        console.error('Mensaje:', err.message);
        await connection.end();
        process.exit(1);
      }
    }

    console.log('\n[init-db] Base de datos importada correctamente.');
  } finally {
    if (connection) await connection.end();
  }
}

run().catch(err => {
  console.error('[init-db] Error inesperado:', err);
  process.exit(1);
});
