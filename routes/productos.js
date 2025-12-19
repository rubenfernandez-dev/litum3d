const express = require('express');
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');

const router = express.Router();

// GET todos los productos activos
router.get('/api/productos', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM productos WHERE activo = TRUE ORDER BY nombre');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener productos' });
  }
});

// GET producto por ID
router.get('/api/productos/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM productos WHERE id = ? AND activo = TRUE', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener producto' });
  }
});

// POST crear producto
router.post('/api/productos', async (req, res) => {
  try {
    const { nombre, descripcion, precio, stock, imagen } = req.body || {};
    if (!nombre || !precio) {
      return res.status(400).json({ error: 'Falta nombre o precio' });
    }
    const [result] = await pool.query(
      'INSERT INTO productos (nombre, descripcion, precio, stock, imagen) VALUES (?, ?, ?, ?, ?)',
      [nombre, descripcion || null, precio, stock || 0, imagen || null]
    );
    res.status(201).json({ id: result.insertId, nombre, precio });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear producto' });
  }
});

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
