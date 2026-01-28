-- Migración: Agregar soporte de videos en reseñas
-- Fecha: 2026-01-28

-- Agregar columna de video URL a la tabla reviews
ALTER TABLE reviews 
ADD COLUMN video_url VARCHAR(500) NULL AFTER comentario,
ADD INDEX idx_video_url (video_url);

-- Nota: Esta migración añade soporte para videos manualmente agregados por admin
-- Los videos se almacenan como URLs (ej: URL de Cloudinary)
-- El usuario solo puede agregar videos manualmente desde el admin dashboard
