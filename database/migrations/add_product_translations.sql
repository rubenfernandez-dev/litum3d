-- Migración: Agregar columnas de traducción a productos y modelos
-- Ejecuta este script en tu base de datos MySQL

USE litum3d;

-- Agregar columnas de traducción a tabla productos
ALTER TABLE productos 
ADD COLUMN IF NOT EXISTS nombre_de VARCHAR(150) COMMENT 'Nombre en alemán',
ADD COLUMN IF NOT EXISTS nombre_fr VARCHAR(150) COMMENT 'Nombre en francés',
ADD COLUMN IF NOT EXISTS descripcion_de TEXT COMMENT 'Descripción en alemán',
ADD COLUMN IF NOT EXISTS descripcion_fr TEXT COMMENT 'Descripción en francés';

-- Agregar columnas de traducción a tabla product_models
ALTER TABLE product_models
ADD COLUMN IF NOT EXISTS nombre_de VARCHAR(150) COMMENT 'Nombre del modelo en alemán',
ADD COLUMN IF NOT EXISTS nombre_fr VARCHAR(150) COMMENT 'Nombre del modelo en francés';

-- Índices para mejorar búsquedas
CREATE INDEX IF NOT EXISTS idx_nombre_de ON productos(nombre_de);
CREATE INDEX IF NOT EXISTS idx_nombre_fr ON productos(nombre_fr);

SELECT 'Migración completada: Columnas de traducción agregadas' AS resultado;
