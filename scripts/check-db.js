/*
  LITUM3D - DB quick verification
*/
require('dotenv').config();
const { pool } = require('../config/db');

async function main() {
  try {
    const checks = [
      { key: 'estado_pedido', sql: 'SELECT COUNT(*) as c FROM estado_pedido' },
      { key: 'usuarios', sql: 'SELECT COUNT(*) as c FROM usuarios WHERE activo = TRUE' },
      { key: 'productos', sql: 'SELECT COUNT(*) as c FROM productos WHERE activo = TRUE' },
      { key: 'pedidos', sql: 'SELECT COUNT(*) as c FROM pedidos' },
      { key: 'detalle_pedidos', sql: 'SELECT COUNT(*) as c FROM detalle_pedidos' },
      { key: 'contacto', sql: 'SELECT COUNT(*) as c FROM contacto' },
    ];

    console.log('Comprobando conexión...');
    await pool.query('SELECT 1');
    console.log('Conexión OK');

    for (const chk of checks) {
      try {
        const [rows] = await pool.query(chk.sql);
        console.log(`${chk.key}: ${rows[0].c}`);
      } catch (e) {
        console.log(`${chk.key}: ERROR -> ${e.message}`);
        const [tables] = await pool.query("SHOW TABLES");
        console.log('Tablas existentes:', tables);
        throw e;
      }
    }

    const [sampleProducts] = await pool.query('SELECT id, nombre, precio FROM productos WHERE activo = TRUE ORDER BY id LIMIT 3');
    console.log('Muestras productos:', sampleProducts);

  } catch (err) {
    console.error('Fallo verificación:', err.message);
    process.exit(1);
  } finally {
    try { await pool.end(); } catch (_) {}
  }
}

main();
