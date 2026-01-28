const express = require('express');
const router = express.Router();
const multer = require('multer');
const { pool } = require('../config/db');
const cloudinary = require('../config/cloudinary');
const fs = require('fs').promises;

// Configurar multer para almacenamiento temporal
const upload = multer({ 
  dest: 'uploads/temp/',
  limits: { 
    fileSize: 5 * 1024 * 1024, // 5MB máximo por archivo
    files: 5 // Máximo 5 archivos
  },
  fileFilter: (req, file, cb) => {
    // Solo permitir imágenes
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos de imagen'), false);
    }
  }
});

// ============================================
// RUTAS PÚBLICAS
// ============================================

// GET /api/reviews - Obtener reseñas aprobadas (para frontend público)
router.get('/api/reviews', async (req, res) => {
  try {
    const { destacadas } = req.query;
    
    let query = `
      SELECT r.*, 
        GROUP_CONCAT(ri.cloudinary_url ORDER BY ri.orden) as imagenes
      FROM reviews r
      LEFT JOIN review_images ri ON r.id = ri.review_id
      WHERE r.estado = 'aprobada'
    `;
    
    if (destacadas === 'true') {
      query += ' AND r.destacada = TRUE';
    }
    
    query += ' GROUP BY r.id ORDER BY r.fecha_creacion DESC';
    
    const [reviews] = await pool.query(query);
    
    // Convertir string de imágenes a array
    const reviewsFormatted = reviews.map(review => ({
      ...review,
      imagenes: review.imagenes ? review.imagenes.split(',') : []
    }));
    
    res.json(reviewsFormatted);
  } catch (error) {
    console.error('Error obteniendo reseñas:', error);
    res.status(500).json({ error: 'Error al obtener reseñas' });
  }
});

// POST /api/reviews - Crear nueva reseña desde frontend (queda pendiente)
router.post('/api/reviews', upload.array('fotos', 5), async (req, res) => {
  const conn = await pool.getConnection();
  
  try {
    await conn.beginTransaction();
    
    const { nombre, email, comentario, rating } = req.body;
    
    // Validaciones
    if (!nombre || !comentario || !rating) {
      throw new Error('Faltan campos obligatorios');
    }
    
    if (rating < 1 || rating > 5) {
      throw new Error('Rating debe estar entre 1 y 5');
    }
    
    // Insertar reseña (estado: pendiente para moderación)
    const [result] = await conn.query(
      'INSERT INTO reviews (nombre, email, comentario, rating, estado) VALUES (?, ?, ?, ?, ?)',
      [nombre, email || null, comentario, rating, 'pendiente']
    );
    
    const reviewId = result.insertId;
    
    // Subir imágenes a Cloudinary si hay
    if (req.files && req.files.length > 0) {
      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];
        
        try {
          // Subir a Cloudinary
          const uploadResult = await cloudinary.uploader.upload(file.path, {
            folder: 'litum3d/reviews',
            transformation: [
              { width: 800, height: 800, crop: 'limit' },
              { quality: 'auto:good' }
            ]
          });
          
          // Guardar referencia en BD
          await conn.query(
            'INSERT INTO review_images (review_id, cloudinary_url, cloudinary_public_id, orden) VALUES (?, ?, ?, ?)',
            [reviewId, uploadResult.secure_url, uploadResult.public_id, i]
          );
          
          // Eliminar archivo temporal
          await fs.unlink(file.path).catch(() => {});
        } catch (uploadError) {
          console.error('Error subiendo imagen:', uploadError);
          // Continuar con las demás imágenes
        }
      }
    }
    
    await conn.commit();
    
    res.json({ 
      success: true, 
      message: 'Reseña enviada correctamente. Será publicada tras revisión.',
      reviewId 
    });
    
  } catch (error) {
    await conn.rollback();
    console.error('Error creando reseña:', error);
    res.status(400).json({ error: error.message || 'Error al crear reseña' });
  } finally {
    conn.release();
    
    // Limpiar archivos temporales
    if (req.files) {
      for (const file of req.files) {
        await fs.unlink(file.path).catch(() => {});
      }
    }
  }
});

// ============================================
// RUTAS ADMIN (requieren autenticación)
// ============================================

// Middleware para verificar que el usuario es admin
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.admin) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

// GET /api/admin/reviews - Obtener todas las reseñas (admin)
router.get('/api/admin/reviews', requireAdmin, async (req, res) => {
  try {
    const { estado } = req.query;
    
    let query = `
      SELECT r.*, 
        GROUP_CONCAT(ri.cloudinary_url ORDER BY ri.orden) as imagenes,
        GROUP_CONCAT(ri.cloudinary_public_id ORDER BY ri.orden) as image_ids
      FROM reviews r
      LEFT JOIN review_images ri ON r.id = ri.review_id
    `;
    
    if (estado) {
      query += ' WHERE r.estado = ?';
    }
    
    query += ' GROUP BY r.id ORDER BY r.fecha_creacion DESC';
    
    const [reviews] = estado 
      ? await pool.query(query, [estado])
      : await pool.query(query);
    
    // Formatear datos
    const reviewsFormatted = reviews.map(review => ({
      ...review,
      imagenes: review.imagenes ? review.imagenes.split(',') : [],
      image_ids: review.image_ids ? review.image_ids.split(',') : []
    }));
    
    res.json(reviewsFormatted);
  } catch (error) {
    console.error('Error obteniendo reseñas admin:', error);
    res.status(500).json({ error: 'Error al obtener reseñas' });
  }
});

// POST /api/admin/reviews - Crear reseña desde admin
router.post('/api/admin/reviews', requireAdmin, upload.array('fotos', 5), async (req, res) => {
  const conn = await pool.getConnection();
  
  try {
    await conn.beginTransaction();
    
    const { nombre, email, comentario, rating, estado, destacada } = req.body;
    
    // Validaciones
    if (!nombre || !comentario || !rating) {
      throw new Error('Faltan campos obligatorios');
    }
    
    // Insertar reseña
    const [result] = await conn.query(
      'INSERT INTO reviews (nombre, email, comentario, rating, estado, destacada) VALUES (?, ?, ?, ?, ?, ?)',
      [nombre, email || null, comentario, rating, estado || 'aprobada', destacada === 'true' ? 1 : 0]
    );
    
    const reviewId = result.insertId;
    
    // Subir imágenes a Cloudinary si hay
    if (req.files && req.files.length > 0) {
      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];
        
        const uploadResult = await cloudinary.uploader.upload(file.path, {
          folder: 'litum3d/reviews',
          transformation: [
            { width: 800, height: 800, crop: 'limit' },
            { quality: 'auto:good' }
          ]
        });
        
        await conn.query(
          'INSERT INTO review_images (review_id, cloudinary_url, cloudinary_public_id, orden) VALUES (?, ?, ?, ?)',
          [reviewId, uploadResult.secure_url, uploadResult.public_id, i]
        );
        
        await fs.unlink(file.path).catch(() => {});
      }
    }
    
    await conn.commit();
    
    res.json({ 
      success: true, 
      message: 'Reseña creada correctamente',
      reviewId 
    });
    
  } catch (error) {
    await conn.rollback();
    console.error('Error creando reseña admin:', error);
    res.status(400).json({ error: error.message || 'Error al crear reseña' });
  } finally {
    conn.release();
    
    if (req.files) {
      for (const file of req.files) {
        await fs.unlink(file.path).catch(() => {});
      }
    }
  }
});

// PATCH /api/admin/reviews/:id - Actualizar estado de reseña
router.patch('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { estado, destacada } = req.body;
    
    const updates = [];
    const values = [];
    
    if (estado) {
      updates.push('estado = ?');
      values.push(estado);
    }
    
    if (destacada !== undefined) {
      updates.push('destacada = ?');
      values.push(destacada ? 1 : 0);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }
    
    values.push(id);
    
    await pool.query(
      `UPDATE reviews SET ${updates.join(', ')} WHERE id = ?`,
      values
    );
    
    res.json({ success: true, message: 'Reseña actualizada' });
  } catch (error) {
    console.error('Error actualizando reseña:', error);
    res.status(500).json({ error: 'Error al actualizar reseña' });
  }
});

// DELETE /api/admin/reviews/:id - Eliminar reseña
router.delete('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
  const conn = await pool.getConnection();
  
  try {
    await conn.beginTransaction();
    
    const { id } = req.params;
    
    // Obtener imágenes de Cloudinary para eliminarlas
    const [images] = await conn.query(
      'SELECT cloudinary_public_id FROM review_images WHERE review_id = ?',
      [id]
    );
    
    // Eliminar imágenes de Cloudinary
    for (const image of images) {
      try {
        await cloudinary.uploader.destroy(image.cloudinary_public_id);
      } catch (error) {
        console.error('Error eliminando imagen de Cloudinary:', error);
        // Continuar aunque falle
      }
    }
    
    // Eliminar reseña (las imágenes se eliminan por CASCADE)
    await conn.query('DELETE FROM reviews WHERE id = ?', [id]);
    
    await conn.commit();
    
    res.json({ success: true, message: 'Reseña eliminada correctamente' });
  } catch (error) {
    await conn.rollback();
    console.error('Error eliminando reseña:', error);
    res.status(500).json({ error: 'Error al eliminar reseña' });
  } finally {
    conn.release();
  }
});

module.exports = router;
