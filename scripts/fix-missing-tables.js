/*
  LITUM3D - Fix missing tables if import skipped some
*/
require('dotenv').config();
const mysql = require('mysql2/promise');

const {
  DB_HOST = 'localhost',
  DB_PORT = 3306,
  DB_USER = 'root',
  DB_PASSWORD = '',
  DB_NAME = 'litum3d'
} = process.env;

async function tableExists(conn, name) {
  const [rows] = await conn.query(
    'SELECT COUNT(*) as c FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
    [DB_NAME, name]
  );
  return rows[0].c > 0;
}

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    'SELECT COUNT(*) as c FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?',
    [DB_NAME, table, column]
  );
  return rows[0].c > 0;
}

async function main() {
  const conn = await mysql.createConnection({
    host: DB_HOST,
    port: Number(DB_PORT),
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    multipleStatements: false
  });

  try {
    // usuarios
    if (!(await tableExists(conn, 'usuarios'))) {
      console.log('Creando tabla usuarios...');
      await conn.query(`
        CREATE TABLE IF NOT EXISTS usuarios (
          id INT PRIMARY KEY AUTO_INCREMENT,
          nombre VARCHAR(100) NOT NULL,
          email VARCHAR(100) NOT NULL UNIQUE,
          telefono VARCHAR(20),
          direccion VARCHAR(255),
          \`contraseña\` VARCHAR(255) NOT NULL,
          activo BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_email (email),
          INDEX idx_activo (activo)
        ) ENGINE=InnoDB;
      `);
      console.log('usuarios OK');
    } else {
      console.log('usuarios ya existe');
    }

    // product_models
    if (!(await tableExists(conn, 'product_models'))) {
      console.log('Creando tabla product_models...');
      await conn.query(`
        CREATE TABLE IF NOT EXISTS product_models (
          id INT PRIMARY KEY AUTO_INCREMENT,
          product_id INT NOT NULL,
          nombre VARCHAR(150) NOT NULL,
          sku VARCHAR(100),
          price_delta DECIMAL(10, 2) DEFAULT 0,
          stock INT DEFAULT 0,
          imagen VARCHAR(255),
          is_default BOOLEAN DEFAULT FALSE,
          activo BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (product_id) REFERENCES productos(id) ON DELETE CASCADE,
          INDEX idx_product_id (product_id),
          INDEX idx_model_active (activo)
        ) ENGINE=InnoDB;
      `);
    } else {
      console.log('product_models ya existe');
    }

    // pedidos
    if (!(await tableExists(conn, 'pedidos'))) {
      console.log('Creando tabla pedidos...');
      await conn.query(`
        CREATE TABLE IF NOT EXISTS pedidos (
          id INT PRIMARY KEY AUTO_INCREMENT,
          usuario_id INT NOT NULL,
          estado_id INT NOT NULL DEFAULT 1,
          total DECIMAL(10, 2) NOT NULL,
          notas TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
          FOREIGN KEY (estado_id) REFERENCES estado_pedido(id),
          INDEX idx_usuario_id (usuario_id),
          INDEX idx_estado_id (estado_id),
          INDEX idx_created_at (created_at)
        ) ENGINE=InnoDB;
      `);
      console.log('pedidos OK');
    } else {
      console.log('pedidos ya existe');
    }

    // detalle_pedidos
    if (!(await tableExists(conn, 'detalle_pedidos'))) {
      console.log('Creando tabla detalle_pedidos...');
      await conn.query(`
        CREATE TABLE IF NOT EXISTS detalle_pedidos (
          id INT PRIMARY KEY AUTO_INCREMENT,
          pedido_id INT NOT NULL,
          producto_id INT NOT NULL,
          modelo_id INT,
          cantidad INT NOT NULL,
          precio_unitario DECIMAL(10, 2) NOT NULL,
          subtotal DECIMAL(10, 2) GENERATED ALWAYS AS (cantidad * precio_unitario) STORED,
          personalizacion_notas TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE,
          FOREIGN KEY (producto_id) REFERENCES productos(id),
          FOREIGN KEY (modelo_id) REFERENCES product_models(id) ON DELETE SET NULL,
          INDEX idx_pedido_id (pedido_id),
          INDEX idx_producto_id (producto_id),
          INDEX idx_modelo_id (modelo_id)
        ) ENGINE=InnoDB;
      `);
      console.log('detalle_pedidos OK');
    } else {
      console.log('detalle_pedidos ya existe');
      if (!(await columnExists(conn, 'detalle_pedidos', 'modelo_id'))) {
        console.log('Añadiendo columna modelo_id...');
        await conn.query('ALTER TABLE detalle_pedidos ADD COLUMN modelo_id INT NULL AFTER producto_id');
        await conn.query('ALTER TABLE detalle_pedidos ADD FOREIGN KEY (modelo_id) REFERENCES product_models(id) ON DELETE SET NULL');
        await conn.query('CREATE INDEX idx_modelo_id ON detalle_pedidos (modelo_id)');
      }
      if (!(await columnExists(conn, 'detalle_pedidos', 'personalizacion_notas'))) {
        console.log('Añadiendo columna personalizacion_notas...');
        await conn.query('ALTER TABLE detalle_pedidos ADD COLUMN personalizacion_notas TEXT AFTER subtotal');
      }
    }

    // detalle_pedido_imagenes
    if (!(await tableExists(conn, 'detalle_pedido_imagenes'))) {
      console.log('Creando tabla detalle_pedido_imagenes...');
      await conn.query(`
        CREATE TABLE IF NOT EXISTS detalle_pedido_imagenes (
          id INT PRIMARY KEY AUTO_INCREMENT,
          detalle_pedido_id INT NOT NULL,
          ruta VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (detalle_pedido_id) REFERENCES detalle_pedidos(id) ON DELETE CASCADE,
          INDEX idx_detalle_pedido_id (detalle_pedido_id)
        ) ENGINE=InnoDB;
      `);
    } else {
      console.log('detalle_pedido_imagenes ya existe');
    }

  } finally {
    await conn.end();
  }

  console.log('Fix completado.');
}

main().catch(e => {
  console.error('Error en fix:', e.message);
  process.exit(1);
});
