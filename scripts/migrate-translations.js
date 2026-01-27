/**
 * Script para ejecutar la migración de traducciones
 * Ejecuta: node scripts/migrate-translations.js
 */

const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  const config = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'litum3d',
    multipleStatements: true
  };

  console.log('🔄 Conectando a la base de datos...');
  
  let connection;
  try {
    connection = await mysql.createConnection(config);
    console.log('✅ Conectado a MySQL');

    // Leer el archivo SQL
    const sqlPath = path.join(__dirname, '..', 'database', 'migrations', 'add_product_translations.sql');
    const sqlContent = fs.readFileSync(sqlPath, 'utf8');

    console.log('📝 Ejecutando migración...');
    await connection.query(sqlContent);

    console.log('✅ Migración completada exitosamente!');
    console.log('');
    console.log('Columnas agregadas:');
    console.log('  - productos: nombre_de, nombre_fr, descripcion_de, descripcion_fr');
    console.log('  - product_models: nombre_de, nombre_fr');
    console.log('');
    console.log('🎉 Ahora puedes agregar traducciones desde el panel de administración');

  } catch (error) {
    console.error('❌ Error durante la migración:', error.message);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

runMigration();
