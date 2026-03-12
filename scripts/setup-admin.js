require('dotenv').config();
const { pool } = require('../config/db');
const bcrypt = require('bcryptjs');

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
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
    const [adminCheck] = await pool.query('SELECT id FROM usuarios WHERE email = ?', [adminEmail]);

    const tempPassword = 'CHANGE_ME_' + Math.random().toString(36).substring(2, 15);

    if (adminCheck.length > 0) {
      console.log('   ✓ Usuario admin ya existe\n');
      console.log('📊 Datos de acceso:');
      console.log(`   Email: ${adminEmail}`);
      console.log('   Contraseña: Debe ser configurada en producción\n');
    } else {
      // Crear usuario admin
      console.log('   Creando usuario admin...');
      const insertQuery = `
        INSERT INTO usuarios (nombre, email, contraseña, activo, es_admin)
        VALUES (?, ?, ?, TRUE, TRUE)
      `;
      const passwordHash = await bcrypt.hash(tempPassword, 10);
      const [result] = await pool.query(insertQuery, ['Administrator', adminEmail, passwordHash]);
      
      console.log('   ✓ Usuario admin creado\n');
      console.log('📊 Datos de acceso:');
      console.log(`   Email: ${adminEmail}`);
      console.log('   ⚠️  IMPORTANTE: Esta contraseña temporal debe cambiarse inmediatamente en producción\n');
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
