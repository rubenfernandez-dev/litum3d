-- LITUM3D E-Commerce Database Schema
-- Ejecuta este script en tu servidor MySQL

CREATE DATABASE IF NOT EXISTS litum3d CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE litum3d;

-- Tabla: estado_pedido
CREATE TABLE IF NOT EXISTS estado_pedido (
  id INT PRIMARY KEY AUTO_INCREMENT,
  nombre VARCHAR(50) NOT NULL UNIQUE,
  descripcion TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Tabla: usuarios
CREATE TABLE IF NOT EXISTS usuarios (
  id INT PRIMARY KEY AUTO_INCREMENT,
  nombre VARCHAR(100) NOT NULL,
  email VARCHAR(100) NOT NULL UNIQUE,
  telefono VARCHAR(20),
  direccion VARCHAR(255),
  contraseña VARCHAR(255) NOT NULL,
  activo BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_email (email),
  INDEX idx_activo (activo)
) ENGINE=InnoDB;

-- Tabla: productos
CREATE TABLE IF NOT EXISTS productos (
  id INT PRIMARY KEY AUTO_INCREMENT,
  nombre VARCHAR(150) NOT NULL,
  descripcion TEXT,
  precio DECIMAL(10, 2) NOT NULL,
  stock INT DEFAULT 0,
  imagen VARCHAR(255),
  activo BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_nombre (nombre),
  INDEX idx_activo (activo),
  INDEX idx_stock (stock)
) ENGINE=InnoDB;

-- Tabla: pedidos
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

-- Tabla: detalle_pedidos
CREATE TABLE IF NOT EXISTS detalle_pedidos (
  id INT PRIMARY KEY AUTO_INCREMENT,
  pedido_id INT NOT NULL,
  producto_id INT NOT NULL,
  cantidad INT NOT NULL,
  precio_unitario DECIMAL(10, 2) NOT NULL,
  subtotal DECIMAL(10, 2) GENERATED ALWAYS AS (cantidad * precio_unitario) STORED,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE,
  FOREIGN KEY (producto_id) REFERENCES productos(id),
  INDEX idx_pedido_id (pedido_id),
  INDEX idx_producto_id (producto_id)
) ENGINE=InnoDB;

-- Tabla: contacto
CREATE TABLE IF NOT EXISTS contacto (
  id INT PRIMARY KEY AUTO_INCREMENT,
  nombre VARCHAR(100) NOT NULL,
  email VARCHAR(100) NOT NULL,
  asunto VARCHAR(150),
  mensaje TEXT NOT NULL,
  leido BOOLEAN DEFAULT FALSE,
  respondido BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_leido (leido),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB;

-- DATOS INICIALES (opcional)
INSERT INTO estado_pedido (nombre, descripcion) VALUES
  ('Pendiente', 'Pedido recibido, pendiente de confirmación'),
  ('Confirmado', 'Pedido confirmado'),
  ('Preparando', 'En preparación'),
  ('Enviado', 'Pedido enviado'),
  ('Entregado', 'Pedido entregado'),
  ('Cancelado', 'Pedido cancelado');

-- Usuario de prueba (contraseña: 123456 - CAMBIA EN PRODUCCIÓN)
-- En producción, usa bcrypt: npm install bcrypt
INSERT INTO usuarios (nombre, email, telefono, direccion, contraseña) VALUES
  ('Admin', 'admin@litum3d.local', '+34123456789', 'Calle Test 1', 'admin123');

-- Productos de prueba
INSERT INTO productos (nombre, descripcion, precio, stock, imagen) VALUES
  ('Figura 3D - Dragon', 'Dragon articulado en resina', 45.99, 10, '/img/dragon.jpg'),
  ('Busto clásico', 'Busto de figura clásica', 32.50, 15, '/img/busto.jpg'),
  ('Miniatura medieval', 'Caballero medieval 5cm', 12.99, 30, '/img/miniatura.jpg');
