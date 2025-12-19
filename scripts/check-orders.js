require('dotenv').config();
const { pool } = require('../config/db');

(async () => {
  try {
    const [orders] = await pool.query('SELECT id, total, estado_id, created_at FROM pedidos ORDER BY created_at DESC LIMIT 10');
    console.log('\n📦 Total de pedidos en BD:', orders.length);
    if (orders.length > 0) {
      console.log('\nÚltimos pedidos:');
      orders.forEach(o => {
        const date = new Date(o.created_at).toLocaleString('es-ES');
        console.log(`  Pedido #${o.id} | €${o.total} | Estado ID: ${o.estado_id} | ${date}`);
      });
    } else {
      console.log('❌ No hay pedidos en la BD');
    }
    process.exit(0);
  } catch (e) {
    console.error('❌ Error:', e.message);
    process.exit(1);
  }
})();
