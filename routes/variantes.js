/**
 * ROUTES: Variantes de Productos
 * Maneja tipos de variantes, opciones y combinaciones
 */

const express = require('express');
const { pool } = require('../config/db');
const requireAuth = require('../middleware/requireAuth');
const { csrfProtection } = require('../middleware/csrf');

const router = express.Router();

/**
 * GET - Obtener todos los tipos de variantes de un producto
 * /api/productos/:productId/variant-types
 */
router.get('/api/productos/:productId/variant-types', async (req, res) => {
  try {
    const { productId } = req.params;
    
    const [variantTypes] = await pool.query(
      `SELECT id, nombre, descripcion, is_required, display_order, activo
       FROM product_variant_types
       WHERE product_id = ? AND activo = TRUE
       ORDER BY display_order ASC, nombre ASC`,
      [productId]
    );
    
    // Para cada tipo de variante, obtener sus opciones
    const result = await Promise.all(
      variantTypes.map(async (type) => {
        const [options] = await pool.query(
          `SELECT id, nombre, descripcion, price_delta, stock, imagen, sku, display_order
           FROM product_variant_options
           WHERE variant_type_id = ? AND activo = TRUE
           ORDER BY display_order ASC, nombre ASC`,
          [type.id]
        );
        return { ...type, options };
      })
    );
    
    res.json(result);
  } catch (err) {
    console.error('Error getting variant types:', err);
    res.status(500).json({ error: 'Error al obtener tipos de variantes' });
  }
});

/**
 * GET - Obtener un tipo de variante específico con sus opciones
 * /api/variant-types/:variantTypeId
 */
router.get('/api/variant-types/:variantTypeId', async (req, res) => {
  try {
    const { variantTypeId } = req.params;
    
    const [variantType] = await pool.query(
      `SELECT id, product_id, nombre, descripcion, is_required, display_order, activo
       FROM product_variant_types
       WHERE id = ? AND activo = TRUE`,
      [variantTypeId]
    );
    
    if (!variantType.length) {
      return res.status(404).json({ error: 'Tipo de variante no encontrado' });
    }
    
    const [options] = await pool.query(
      `SELECT id, nombre, descripcion, price_delta, stock, imagen, sku, display_order
       FROM product_variant_options
       WHERE variant_type_id = ? AND activo = TRUE
       ORDER BY display_order ASC, nombre ASC`,
      [variantTypeId]
    );
    
    res.json({ ...variantType[0], options });
  } catch (err) {
    console.error('Error getting variant type:', err);
    res.status(500).json({ error: 'Error al obtener tipo de variante' });
  }
});

/**
 * GET - Obtener opciones disponibles para un tipo de variante
 * /api/variant-types/:variantTypeId/options
 */
router.get('/api/variant-types/:variantTypeId/options', async (req, res) => {
  try {
    const { variantTypeId } = req.params;
    
    const [options] = await pool.query(
      `SELECT id, nombre, descripcion, price_delta, stock, imagen, sku, display_order
       FROM product_variant_options
       WHERE variant_type_id = ? AND activo = TRUE AND stock > 0
       ORDER BY display_order ASC, nombre ASC`,
      [variantTypeId]
    );
    
    res.json(options);
  } catch (err) {
    console.error('Error getting variant options:', err);
    res.status(500).json({ error: 'Error al obtener opciones de variante' });
  }
});

/**
 * POST - Crear nuevo tipo de variante
 * Admin only
 * /api/productos/:productId/variant-types
 */
router.post('/api/productos/:productId/variant-types', requireAuth, csrfProtection, async (req, res) => {
  try {
    const { productId } = req.params;
    const { nombre, descripcion, is_required, display_order } = req.body;
    
    if (!nombre) {
      return res.status(400).json({ error: 'El nombre es requerido' });
    }
    
    const [result] = await pool.query(
      `INSERT INTO product_variant_types (product_id, nombre, descripcion, is_required, display_order)
       VALUES (?, ?, ?, ?, ?)`,
      [productId, nombre, descripcion || null, is_required !== false, display_order || 0]
    );
    
    res.status(201).json({ 
      id: result.insertId, 
      product_id: productId,
      nombre,
      is_required: is_required !== false
    });
  } catch (err) {
    console.error('Error creating variant type:', err);
    res.status(500).json({ error: 'Error al crear tipo de variante' });
  }
});

/**
 * POST - Crear nueva opción de variante
 * Admin only
 * /api/variant-types/:variantTypeId/options
 */
router.post('/api/variant-types/:variantTypeId/options', requireAuth, csrfProtection, async (req, res) => {
  try {
    const { variantTypeId } = req.params;
    const { nombre, descripcion, price_delta, stock, imagen, sku, display_order } = req.body;
    
    if (!nombre) {
      return res.status(400).json({ error: 'El nombre es requerido' });
    }
    
    const [result] = await pool.query(
      `INSERT INTO product_variant_options (variant_type_id, nombre, descripcion, price_delta, stock, imagen, sku, display_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [variantTypeId, nombre, descripcion || null, price_delta || 0, stock || 0, imagen || null, sku || null, display_order || 0]
    );
    
    res.status(201).json({ 
      id: result.insertId, 
      variant_type_id: variantTypeId,
      nombre,
      price_delta: price_delta || 0,
      stock: stock || 0
    });
  } catch (err) {
    console.error('Error creating variant option:', err);
    res.status(500).json({ error: 'Error al crear opción de variante' });
  }
});

/**
 * POST - Validar y calcular precio de una combinación de variantes
 * /api/productos/:productId/calculate-variant-price
 */
router.post('/api/productos/:productId/calculate-variant-price', async (req, res) => {
  try {
    const { productId } = req.params;
    const { selected_variants } = req.body; // { type_id: option_id, ... }
    
    if (!selected_variants || typeof selected_variants !== 'object') {
      return res.status(400).json({ error: 'selected_variants debe ser un objeto' });
    }
    
    // Obtener precio base del producto
    const [product] = await pool.query(
      'SELECT precio FROM productos WHERE id = ?',
      [productId]
    );
    
    if (!product.length) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    
    let baseprice = parseFloat(product[0].precio);
    let totalPriceDelta = 0;
    let isValid = true;
    const selectedDetails = [];
    
    // Validar y calcular deltas para cada variante seleccionada
    for (const [typeId, optionId] of Object.entries(selected_variants)) {
      const [variant] = await pool.query(
        `SELECT pvo.id, pvo.nombre, pvo.price_delta, pvo.stock,
                pvt.nombre as type_name, pvt.is_required
         FROM product_variant_options pvo
         JOIN product_variant_types pvt ON pvo.variant_type_id = pvt.id
         WHERE pvo.id = ? AND pvo.variant_type_id = ? AND pvo.activo = TRUE`,
        [optionId, typeId]
      );
      
      if (!variant.length) {
        return res.status(400).json({ 
          error: `Opción inválida para tipo de variante ${typeId}` 
        });
      }
      
      const option = variant[0];
      if (option.stock <= 0) {
        isValid = false;
      }
      
      totalPriceDelta += parseFloat(option.price_delta || 0);
      selectedDetails.push({
        type_id: typeId,
        type_name: option.type_name,
        option_id: optionId,
        option_name: option.nombre,
        price_delta: option.price_delta,
        stock_available: option.stock
      });
    }
    
    const finalPrice = baseprice + totalPriceDelta;
    
    res.json({
      base_price: baseprice,
      total_delta: totalPriceDelta,
      final_price: finalPrice.toFixed(2),
      is_valid: isValid,
      selected_variants: selectedDetails
    });
  } catch (err) {
    console.error('Error calculating variant price:', err);
    res.status(500).json({ error: 'Error al calcular precio de variantes' });
  }
});

/**
 * PUT - Actualizar tipo de variante
 * Admin only
 * /api/variant-types/:variantTypeId
 */
router.put('/api/variant-types/:variantTypeId', requireAuth, csrfProtection, async (req, res) => {
  try {
    const { variantTypeId } = req.params;
    const { nombre, descripcion, is_required, display_order } = req.body;
    
    const fields = [];
    const values = [];
    
    if (nombre !== undefined) { fields.push('nombre = ?'); values.push(nombre); }
    if (descripcion !== undefined) { fields.push('descripcion = ?'); values.push(descripcion); }
    if (is_required !== undefined) { fields.push('is_required = ?'); values.push(is_required); }
    if (display_order !== undefined) { fields.push('display_order = ?'); values.push(display_order); }
    
    if (!fields.length) {
      return res.status(400).json({ error: 'Sin campos para actualizar' });
    }
    
    values.push(variantTypeId);
    const [result] = await pool.query(
      `UPDATE product_variant_types SET ${fields.join(', ')} WHERE id = ?`,
      values
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Tipo de variante no encontrado' });
    }
    
    res.json({ ok: true });
  } catch (err) {
    console.error('Error updating variant type:', err);
    res.status(500).json({ error: 'Error al actualizar tipo de variante' });
  }
});

/**
 * PUT - Actualizar opción de variante
 * Admin only
 * /api/variant-options/:optionId
 */
router.put('/api/variant-options/:optionId', requireAuth, csrfProtection, async (req, res) => {
  try {
    const { optionId } = req.params;
    const { nombre, descripcion, price_delta, stock, imagen, sku, display_order } = req.body;
    
    const fields = [];
    const values = [];
    
    if (nombre !== undefined) { fields.push('nombre = ?'); values.push(nombre); }
    if (descripcion !== undefined) { fields.push('descripcion = ?'); values.push(descripcion); }
    if (price_delta !== undefined) { fields.push('price_delta = ?'); values.push(price_delta); }
    if (stock !== undefined) { fields.push('stock = ?'); values.push(stock); }
    if (imagen !== undefined) { fields.push('imagen = ?'); values.push(imagen); }
    if (sku !== undefined) { fields.push('sku = ?'); values.push(sku); }
    if (display_order !== undefined) { fields.push('display_order = ?'); values.push(display_order); }
    
    if (!fields.length) {
      return res.status(400).json({ error: 'Sin campos para actualizar' });
    }
    
    values.push(optionId);
    const [result] = await pool.query(
      `UPDATE product_variant_options SET ${fields.join(', ')} WHERE id = ?`,
      values
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Opción de variante no encontrada' });
    }
    
    res.json({ ok: true });
  } catch (err) {
    console.error('Error updating variant option:', err);
    res.status(500).json({ error: 'Error al actualizar opción de variante' });
  }
});

/**
 * DELETE - Desactivar tipo de variante
 * Admin only
 * /api/variant-types/:variantTypeId
 */
router.delete('/api/variant-types/:variantTypeId', requireAuth, csrfProtection, async (req, res) => {
  try {
    const { variantTypeId } = req.params;
    
    const [result] = await pool.query(
      'UPDATE product_variant_types SET activo = FALSE WHERE id = ?',
      [variantTypeId]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Tipo de variante no encontrado' });
    }
    
    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting variant type:', err);
    res.status(500).json({ error: 'Error al desactivar tipo de variante' });
  }
});

/**
 * DELETE - Desactivar opción de variante
 * Admin only
 * /api/variant-options/:optionId
 */
router.delete('/api/variant-options/:optionId', requireAuth, csrfProtection, async (req, res) => {
  try {
    const { optionId } = req.params;
    
    const [result] = await pool.query(
      'UPDATE product_variant_options SET activo = FALSE WHERE id = ?',
      [optionId]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Opción de variante no encontrada' });
    }
    
    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting variant option:', err);
    res.status(500).json({ error: 'Error al desactivar opción de variante' });
  }
});

module.exports = router;
