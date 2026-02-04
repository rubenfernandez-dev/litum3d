/*
  LITUM3D - Migration Runner
  Ejecuta todos los archivos .sql de la carpeta database/migrations
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
  DB_NAME = 'litum3d'
} = process.env;

async function runMigrations() {
  const migrationsDir = path.join(__dirname, '..', 'database', 'migrations');
  
  if (!fs.existsSync(migrationsDir)) {
    console.error(`[migrations] No se encontró el directorio: ${migrationsDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  console.log(`[migrations] Encontradas ${files.length} migraciones`);

  let connection;
  try {
    connection = await mysql.createConnection({
      host: DB_HOST,
      port: Number(DB_PORT),
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME,
      multipleStatements: true
    });

    console.log('[migrations] Conectado a BD');

    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');

      // Remove comments and split by ;
      const withoutBlockComments = sql.replace(/\/\*[\s\S]*?\*\//g, '');
      const lines = withoutBlockComments
        .split('\n')
        .map(l => l.replace(/--.*$/, ''))
        .join('\n');

      const statements = lines
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);

      console.log(`\n[migrations] Ejecutando ${file} (${statements.length} sentencias)...`);

      try {
        for (const stmt of statements) {
          await connection.query(stmt);
        }
        console.log(`✓ ${file} completado`);
      } catch (err) {
        if (err.code === 'ER_DUP_FIELDNAME') {
          console.log(`⚠ ${file} - Columnas ya existen, omitiendo`);
        } else if (err.code === 'ER_DUP_KEYNAME') {
          console.log(`⚠ ${file} - Índices ya existen, omitiendo`);
        } else {
          console.error(`✗ Error en ${file}:`, err.message);
        }
      }
    }

    console.log('\n[migrations] Migraciones completadas');
    process.exit(0);
  } catch (err) {
    console.error('[migrations] Error de conexión:', err.message);
    process.exit(1);
  } finally {
    if (connection) await connection.end();
  }
}

runMigrations();
