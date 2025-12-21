-- LITUM3D - Migración de Variantes (Bases + Formas)
-- Este script crea las tablas necesarias para un sistema de variantes flexible
-- Ejecutar en la base de datos litum3d

-- Tabla: Tipos de Variantes (Base, Forma, Color, Material, etc.)
CREATE TABLE IF NOT EXISTS product_variant_types (
  id INT PRIMARY KEY AUTO_INCREMENT,
  product_id INT NOT NULL,
  nombre VARCHAR(100) NOT NULL,
  descripcion TEXT,
  is_required BOOLEAN DEFAULT TRUE,
  display_order INT DEFAULT 0,
  activo BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES productos(id) ON DELETE CASCADE,
  UNIQUE KEY unique_product_variant_type (product_id, nombre),
  INDEX idx_product_id (product_id),
  INDEX idx_activo (activo)
) ENGINE=InnoDB;

-- Tabla: Opciones de Variantes (Madera, Plástico, Cilíndrico, etc.)
CREATE TABLE IF NOT EXISTS product_variant_options (
  id INT PRIMARY KEY AUTO_INCREMENT,
  variant_type_id INT NOT NULL,
  nombre VARCHAR(150) NOT NULL,
  descripcion TEXT,
  price_delta DECIMAL(10, 2) DEFAULT 0,
  stock INT DEFAULT 0,
  imagen VARCHAR(255),
  sku VARCHAR(100),
  display_order INT DEFAULT 0,
  activo BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (variant_type_id) REFERENCES product_variant_types(id) ON DELETE CASCADE,
  INDEX idx_variant_type_id (variant_type_id),
  INDEX idx_activo (activo)
) ENGINE=InnoDB;

-- Tabla: Combinaciones de Variantes (para tracking de stock)
-- Esto permite controlar stock por combinación específica
CREATE TABLE IF NOT EXISTS product_variant_combinations (
  id INT PRIMARY KEY AUTO_INCREMENT,
  product_id INT NOT NULL,
  sku VARCHAR(100) UNIQUE,
  stock INT DEFAULT 0,
  price_delta DECIMAL(10, 2) DEFAULT 0,
  activo BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES productos(id) ON DELETE CASCADE,
  INDEX idx_product_id (product_id),
  INDEX idx_sku (sku),
  INDEX idx_activo (activo)
) ENGINE=InnoDB;

-- Tabla: Relación entre Combinación y Opciones seleccionadas
CREATE TABLE IF NOT EXISTS product_variant_combination_details (
  id INT PRIMARY KEY AUTO_INCREMENT,
  combination_id INT NOT NULL,
  variant_option_id INT NOT NULL,
  FOREIGN KEY (combination_id) REFERENCES product_variant_combinations(id) ON DELETE CASCADE,
  FOREIGN KEY (variant_option_id) REFERENCES product_variant_options(id) ON DELETE CASCADE,
  UNIQUE KEY unique_combination_option (combination_id, variant_option_id),
  INDEX idx_combination_id (combination_id)
) ENGINE=InnoDB;

-- Tabla actualizada: detalle_pedidos con variantes seleccionadas
-- (Se agrega columna para almacenar variantes seleccionadas como JSON)
ALTER TABLE detalle_pedidos ADD COLUMN IF NOT EXISTS variantes_seleccionadas JSON COMMENT 'Variantes seleccionadas: {"tipo_id": option_id, ...}';
ALTER TABLE detalle_pedidos ADD COLUMN IF NOT EXISTS combination_id INT COMMENT 'Referencia a combinación de variantes' AFTER variantes_seleccionadas;
ALTER TABLE detalle_pedidos ADD FOREIGN KEY IF NOT EXISTS (combination_id) REFERENCES product_variant_combinations(id) ON DELETE SET NULL;

-- EJEMPLO DE DATOS - DESCOMENTA PARA PROBAR
-- ===================================================================
-- Para un producto con ID 1, agregar tipos de variantes
INSERT INTO product_variant_types (product_id, nombre, descripcion, is_required, display_order) 
VALUES 
  (1, 'Base', 'Tipo de base del producto', TRUE, 1),
  (1, 'Forma', 'Forma del producto', TRUE, 2);

-- Agregar opciones para la variante "Base" (obtén el type_id de la consulta anterior)
-- Suponiendo que el primer INSERT tuvo id=1:
INSERT INTO product_variant_options (variant_type_id, nombre, descripcion, price_delta, stock, display_order) 
VALUES 
  (1, 'Madera', 'Base de madera natural', 5.00, 20, 1),
  (1, 'Plástico', 'Base de plástico reforzado', 2.00, 30, 2),
  (1, 'Metal', 'Base de metal cromado', 8.00, 15, 3);

-- Agregar opciones para la variante "Forma" (type_id = 2)
INSERT INTO product_variant_options (variant_type_id, nombre, descripcion, price_delta, stock, display_order) 
VALUES 
  (2, 'Cilíndrica', 'Forma cilíndrica estándar', 0.00, 25, 1),
  (2, 'Cuadrada', 'Forma cuadrada moderna', 3.00, 20, 2),
  (2, 'Hexagonal', 'Forma hexagonal única', 4.50, 15, 3);
-- ===================================================================
