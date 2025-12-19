require('dotenv').config();
const { pool } = require('../config/db');

async function upsertPortavelas() {
  const nombre = 'Portavelas 3D';
  const descripcion = 'Portavelas litofanía personalizado con luz cálida';
  const precio = 24.99;
  const stock = 12;
  const imagen = 'portavelas.jpg'; // Pon tu foto en public/img/productos/portavelas.jpg

  try {
    console.log('🔧 Creando/actualizando producto Portavelas...\n');

    // Buscar si ya existe un producto con ese nombre
    const [rows] = await pool.execute(
      'SELECT id FROM productos WHERE LOWER(nombre) LIKE ? LIMIT 1',
      ['portavelas%']
    );

    if (rows.length > 0) {
      const id = rows[0].id;
      await pool.execute(
        'UPDATE productos SET nombre = ?, descripcion = ?, precio = ?, stock = ?, imagen = ? WHERE id = ?',
        [nombre, descripcion, precio, stock, imagen, id]
      );
      console.log(`✅ Actualizado producto existente (id ${id})`);
    } else {
      const [result] = await pool.execute(
        'INSERT INTO productos (nombre, descripcion, precio, stock, imagen) VALUES (?, ?, ?, ?, ?)',
        [nombre, descripcion, precio, stock, imagen]
      );
      console.log(`✅ Insertado nuevo producto Portavelas con id ${result.insertId}`);
    }

    console.log('\n📸 Recuerda copiar tu foto a: public/img/productos/portavelas.jpg');
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await pool.end();
  }
}

upsertPortavelas();
