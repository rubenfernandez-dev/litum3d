require('dotenv').config();
const { pool } = require('../config/db');

async function setupAdmin() {
  try {
    console.log('🔧 Configurando panel admin...\n');

    // 1. Agregar columna es_admin si no existe
    console.log('📝 Verificando estructura de tabla usuarios...');
    const checkColQuery = `
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'usuarios' AND COLUMN_NAME = 'es_admin' AND TABLE_SCHEMA = ?
    `;
    const [columns] = await pool.query(checkColQuery, [process.env.DB_NAME || 'litum3d']);

    if (columns.length === 0) {
      console.log('   Agregando columna es_admin...');
      await pool.query('ALTER TABLE usuarios ADD COLUMN es_admin BOOLEAN DEFAULT FALSE');
      console.log('   ✓ Columna es_admin agregada\n');
    } else {
      console.log('   ✓ Columna es_admin ya existe\n');
    }

    // 2. Verificar si existe admin
    console.log('🔐 Verificando usuario admin...');
    const adminEmail = 'admin@litum3d.com';
    const [adminCheck] = await pool.query('SELECT id FROM usuarios WHERE email = ?', [adminEmail]);

    if (adminCheck.length > 0) {
      console.log('   ✓ Usuario admin ya existe\n');
      console.log('📊 Datos de acceso:');
      console.log(`   Email: ${adminEmail}`);
      console.log(`   Contraseña: admin123 (cámbiala en producción)\n`);
    } else {
      // Crear usuario admin
      console.log('   Creando usuario admin...');
      const insertQuery = `
        INSERT INTO usuarios (nombre, email, contraseña, activo, es_admin)
        VALUES (?, ?, ?, TRUE, TRUE)
      `;
      // Nota: En producción, usar bcrypt o scrypt para hashear contraseña
      const [result] = await pool.query(insertQuery, ['Administrator', adminEmail, 'admin123']);
      
      console.log('   ✓ Usuario admin creado\n');
      console.log('📊 Datos de acceso:');
      console.log(`   Email: ${adminEmail}`);
      console.log(`   Contraseña: admin123`);
      console.log('   ⚠️  IMPORTANTE: Cambia la contraseña en producción\n');
    }

    console.log('✅ Panel admin configurado correctamente!\n');
    console.log('🔗 Accede en: http://localhost:3000/admin/login\n');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error configurando admin:', error);
    process.exit(1);
  }
}

setupAdmin();
