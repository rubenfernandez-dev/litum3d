require('dotenv').config();
const { pool } = require('../config/db');

// ============================================
// 🎨 CONFIGURA TUS PRODUCTOS AQUÍ
// ============================================

const productosConImagenes = [
  { id: 1, imagen: 'pared1.jpg', nombre: 'Litofanía Pared Diseño 1' },
  { id: 2, imagen: 'mesa1.png', nombre: 'Litofanía Mesa Premium' },
  { id: 3, imagen: 'techo1.jpg', nombre: 'Litofanía Techo Elegante' },
  
  // Agrega más productos aquí:
  // { id: 4, imagen: 'pared2.jpg', nombre: 'Litofanía Pared Diseño 2' },
  // { id: 5, imagen: 'mesa2.jpg', nombre: 'Litofanía Mesa Clásica' },
];

// ============================================

async function actualizarProductos() {
  try {
    console.log('📸 Actualizando productos con tus fotos...\n');

    for (const producto of productosConImagenes) {
      // Actualizar imagen
      await pool.execute(
        'UPDATE productos SET imagen = ? WHERE id = ?',
        [producto.imagen, producto.id]
      );
      
      // Si quieres también actualizar el nombre:
      if (producto.nombre) {
        await pool.execute(
          'UPDATE productos SET nombre = ? WHERE id = ?',
          [producto.nombre, producto.id]
        );
      }
      
      console.log(`✅ Producto ${producto.id}: ${producto.nombre} → ${producto.imagen}`);
    }

    console.log('\n✅ ¡Actualización completa!');
    console.log('\n📋 Fotos disponibles en public/img/productos/:');
    const fs = require('fs');
    const fotos = fs.readdirSync('./public/img/productos');
    fotos.forEach(f => console.log(`   - ${f}`));
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await pool.end();
  }
}

actualizarProductos();
