require('dotenv').config();
const { pool } = require('../config/db');

async function listProducts() {
  try {
    console.log('✅ Conectando a la base de datos...\n');

    const [products] = await pool.execute('SELECT id, nombre, imagen FROM productos');
    
    console.log('📦 PRODUCTOS ACTUALES:\n');
    console.log('ID | Nombre | Imagen actual');
    console.log('---|--------|---------------');
    
    products.forEach(p => {
      console.log(`${p.id}  | ${p.nombre.padEnd(30)} | ${p.imagen || '❌ Sin imagen'}`);
    });
    
    console.log('\n💡 Copia las imágenes a: public/img/productos/');
    console.log('💡 Luego ejecuta: node scripts/actualizar-mis-fotos.js\n');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await pool.end();
  }
}

listProducts();
