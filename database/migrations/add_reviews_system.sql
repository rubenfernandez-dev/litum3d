-- Migración: Sistema de reseñas con Cloudinary
-- Fecha: 2026-01-28

-- Tabla principal de reseñas
CREATE TABLE IF NOT EXISTS reviews (
  id INT PRIMARY KEY AUTO_INCREMENT,
  nombre VARCHAR(100) NOT NULL,
  email VARCHAR(150),
  comentario TEXT NOT NULL,
  video_url VARCHAR(500) NULL,
  rating TINYINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
  estado ENUM('pendiente', 'aprobada', 'rechazada') DEFAULT 'pendiente',
  destacada BOOLEAN DEFAULT FALSE,
  fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  fecha_actualizacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_estado (estado),
  INDEX idx_destacada (destacada),
  INDEX idx_fecha (fecha_creacion),
  INDEX idx_video_url (video_url)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla de imágenes de reseñas (relación 1:N)
CREATE TABLE IF NOT EXISTS review_images (
  id INT PRIMARY KEY AUTO_INCREMENT,
  review_id INT NOT NULL,
  cloudinary_url VARCHAR(500) NOT NULL,
  cloudinary_public_id VARCHAR(200) NOT NULL,
  orden TINYINT DEFAULT 0,
  fecha_subida TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE,
  INDEX idx_review_id (review_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
