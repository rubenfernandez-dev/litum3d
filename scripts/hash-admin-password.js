require('dotenv').config();
const { pool } = require('../config/db');
const bcrypt = require('bcryptjs');

(async () => {
  try {
    const newPassword = process.env.ADMIN_PASSWORD || 'admin123';
    const [rows] = await pool.query('SELECT id, email, contraseña FROM usuarios WHERE es_admin = 1 LIMIT 1');
    if (rows.length === 0) {
      console.log('❌ No existe usuario admin en la tabla usuarios');
      process.exit(1);
    }

    const admin = rows[0];
    const isHashed = admin.contraseña.startsWith('$2a$') || admin.contraseña.startsWith('$2b$') || admin.contraseña.startsWith('$2y$');
    if (isHashed) {
      console.log('✓ La contraseña del admin ya está hasheada para', admin.email);
      process.exit(0);
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE usuarios SET contraseña = ? WHERE id = ?', [passwordHash, admin.id]);
    console.log('✓ Contraseña del admin hasheada correctamente para', admin.email);
    process.exit(0);
  } catch (e) {
    console.error('❌ Error:', e.message);
    process.exit(1);
  }
})();
