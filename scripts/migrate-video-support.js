const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

require('dotenv').config();

async function runMigration() {
  try {
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME
    });

    console.log('✅ Conectado a la base de datos');

    const migrationPath = path.join(__dirname, '..', 'database', 'migrations', 'add_video_support.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    const statements = sql
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt && !stmt.startsWith('--'));

    for (const statement of statements) {
      await connection.query(statement);
      console.log('✅ Ejecutado:', statement.substring(0, 50).trim() + '...');
    }

    console.log('\n✅ Migración de video completada');

    await connection.end();
  } catch (error) {
    console.error('❌ Error en migración:', error.message);
    process.exit(1);
  }
}

runMigration();
