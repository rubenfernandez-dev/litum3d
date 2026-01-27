const express = require('express');
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');

const router = express.Router();

// GET todos los productos activos (con soporte de idiomas)
router.get('/api/productos', async (req, res) => {
  try {
    const lang = req.query.lang || 'es'; // idioma desde query: ?lang=de o ?lang=fr
    const [rows] = await pool.query('SELECT * FROM productos WHERE activo = TRUE ORDER BY nombre');
    
    // Traducir según idioma si existe
    const translated = rows.map(product => {
      if (lang === 'de' && product.nombre_de) {
        return {
          ...product,
          nombre: product.nombre_de,
          descripcion: product.descripcion_de || product.descripcion
        };
      } else if (lang === 'fr' && product.nombre_fr) {
        return {
          ...product,
          nombre: product.nombre_fr,
          descripcion: product.descripcion_fr || product.descripcion
        };
      }
      return product; // español por defecto
    });
    
    res.json(translated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener productos' });
  }
});

// GET producto por ID (con soporte de idiomas)
router.get('/api/productos/:id', async (req, res) => {
  try {
    const lang = req.query.lang || 'es';
    const [rows] = await pool.query('SELECT * FROM productos WHERE id = ? AND activo = TRUE', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Producto no encontrado' });
    
    let product = rows[0];
    // Traducir si existe
    if (lang === 'de' && product.nombre_de) {
      product.nombre = product.nombre_de;
      product.descripcion = product.descripcion_de || product.descripcion;
    } else if (lang === 'fr' && product.nombre_fr) {
      product.nombre = product.nombre_fr;
      product.descripcion = product.descripcion_fr || product.descripcion;
    }
    
    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener producto' });
  }
});

// GET modelos activos de un producto (con soporte de idiomas)
router.get('/api/productos/:id/modelos', async (req, res) => {
  try {
    const productId = req.params.id;
    const lang = req.query.lang || 'es';
    const [rows] = await pool.query(
      `SELECT id, product_id, nombre, nombre_de, nombre_fr, sku, price_delta, stock, imagen, is_default, activo
       FROM product_models
       WHERE product_id = ? AND activo = TRUE
       ORDER BY is_default DESC, nombre ASC`,
      [productId]
    );
    
    // Traducir modelos
    const translated = rows.map(model => {
      if (lang === 'de' && model.nombre_de) {
        return { ...model, nombre: model.nombre_de };
      } else if (lang === 'fr' && model.nombre_fr) {
        return { ...model, nombre: model.nombre_fr };
      }
      return model;
    });
    
    res.json(translated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener modelos' });
  }
});

// POST crear producto
router.post('/api/productos', async (req, res) => {
  try {
    const { nombre, descripcion, precio, stock, imagen } = req.body || {};
    if (!nombre || !precio) {
      return res.status(400).json({ error: 'Falta nombre o precio' });
    } (con soporte de traducciones)
router.put('/api/productos/:id', async (req, res) => {
  try {
    const { nombre, descripcion, precio, stock, imagen, nombre_de, nombre_fr, descripcion_de, descripcion_fr } = req.body || {};
    const fields = [];
    const values = [];
    if (nombre !== undefined) { fields.push('nombre = ?'); values.push(nombre); }
    if (descripcion !== undefined) { fields.push('descripcion = ?'); values.push(descripcion); }
    if (precio !== undefined) { fields.push('precio = ?'); values.push(precio); }
    if (stock !== undefined) { fields.push('stock = ?'); values.push(stock); }
    if (imagen !== undefined) { fields.push('imagen = ?'); values.push(imagen); }
    if (nombre_de !== undefined) { fields.push('nombre_de = ?'); values.push(nombre_de); }
    if (nombre_fr !== undefined) { fields.push('nombre_fr = ?'); values.push(nombre_fr); }
    if (descripcion_de !== undefined) { fields.push('descripcion_de = ?'); values.push(descripcion_de); }
    if (descripcion_fr !== undefined) { fields.push('descripcion_fr = ?'); values.push(descripcion_fr

// PUT actualizar producto
router.put('/api/productos/:id', async (req, res) => {
  try {
    const { nombre, descripcion, precio, stock, imagen } = req.body || {};
    const fields = [];
    const values = [];
    if (nombre !== undefined) { fields.push('nombre = ?'); values.push(nombre); }
    if (descripcion !== undefined) { fields.push('descripcion = ?'); values.push(descripcion); }
    if (precio !== undefined) { fields.push('precio = ?'); values.push(precio); }
    if (stock !== undefined) { fields.push('stock = ?'); values.push(stock); }
    if (imagen !== undefined) { fields.push('imagen = ?'); values.push(imagen); }
    if (!fields.length) return res.status(400).json({ error: 'Sin campos para actualizar' });
    values.push(req.params.id);
    const [result] = await pool.query(`UPDATE productos SET ${fields.join(', ')} WHERE id = ?`, values);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar producto' });
  }
});

// DELETE desactivar producto
router.delete('/api/productos/:id', async (req, res) => {
  try {
    const [result] = await pool.query('UPDATE productos SET activo = FALSE WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al desactivar producto' });
  }
});

// GET imágenes estáticas de la carpeta public/img/productos
router.get('/api/galeria-estatica', async (req, res) => {
  try {
    const dir = path.join(__dirname, '..', 'public', 'img', 'productos');
    const files = await fs.promises.readdir(dir);
    const items = files
      .filter(f => /\.(png|jpg|jpeg|webp|gif)$/i.test(f))
      .map((filename, idx) => ({
        id: `static-${idx}`,
        nombre: path.parse(filename).name.replace(/[-_]/g, ' '),
        descripcion: 'Imagen de galería',
        precio: 0,
        stock: 0,
        imagen: filename
      }));
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al leer imágenes' });
  }
});

module.exports = router;
