const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

require('dotenv').config();

async function runMigration() {
  try {
    // Conexión a MySQL
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME
    });

    console.log('✅ Conectado a la base de datos');

    // Leer y ejecutar migración
    const migrationPath = path.join(__dirname, '..', 'database', 'migrations', 'add_reviews_system.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    // Dividir por puntos y coma y ejecutar cada statement
    const statements = sql.split(';').filter(stmt => stmt.trim());
    
    for (const statement of statements) {
      if (statement.trim()) {
        await connection.execute(statement);
        console.log('✅ Ejecutado:', statement.substring(0, 50).trim() + '...');
      }
    }

    console.log('\n✅ Migración completada exitosamente');
    console.log('📊 Tablas de reseñas creadas:');
    console.log('   - reviews');
    console.log('   - review_images');

    await connection.end();
  } catch (error) {
    console.error('❌ Error en migración:', error.message);
    process.exit(1);
  }
}

runMigration();
