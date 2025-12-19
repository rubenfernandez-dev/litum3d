const express = require('express');
const { pool } = require('../config/db');

const router = express.Router();

// GET todos los pedidos con detalles
router.get('/api/pedidos', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT p.*, e.nombre as estado_nombre, u.nombre as usuario_nombre 
      FROM pedidos p 
      JOIN estado_pedido e ON p.estado_id = e.id 
      JOIN usuarios u ON p.usuario_id = u.id 
      ORDER BY p.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener pedidos' });
  }
});

// GET pedido por ID con detalles
router.get('/api/pedidos/:id', async (req, res) => {
  try {
    const [pedido] = await pool.query(`
      SELECT p.*, e.nombre as estado_nombre, u.nombre as usuario_nombre 
      FROM pedidos p 
      JOIN estado_pedido e ON p.estado_id = e.id 
      JOIN usuarios u ON p.usuario_id = u.id 
      WHERE p.id = ?
    `, [req.params.id]);
    if (!pedido.length) return res.status(404).json({ error: 'Pedido no encontrado' });
    
    const [detalles] = await pool.query(`
      SELECT dp.*, pr.nombre as producto_nombre 
      FROM detalle_pedidos dp 
      JOIN productos pr ON dp.producto_id = pr.id 
      WHERE dp.pedido_id = ?
    `, [req.params.id]);
    
    res.json({ ...pedido[0], detalles });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener pedido' });
  }
});

// POST crear pedido
router.post('/api/pedidos', async (req, res) => {
  try {
    const { usuario_id, detalles, notas } = req.body || {};
    if (!usuario_id || !detalles || !detalles.length) {
      return res.status(400).json({ error: 'Falta usuario_id o detalles' });
    }

    // Calcular total y crear pedido
    let total = 0;
    for (const item of detalles) {
      const [prod] = await pool.query('SELECT precio FROM productos WHERE id = ?', [item.producto_id]);
      if (!prod.length) throw new Error('Producto no encontrado');
      total += prod[0].precio * item.cantidad;
    }

    const [result] = await pool.query(
      'INSERT INTO pedidos (usuario_id, total, notas) VALUES (?, ?, ?)',
      [usuario_id, total, notas || null]
    );

    // Insertar detalles
    for (const item of detalles) {
      const [prod] = await pool.query('SELECT precio FROM productos WHERE id = ?', [item.producto_id]);
      await pool.query(
        'INSERT INTO detalle_pedidos (pedido_id, producto_id, cantidad, precio_unitario) VALUES (?, ?, ?, ?)',
        [result.insertId, item.producto_id, item.cantidad, prod[0].precio]
      );
    }

    res.status(201).json({ id: result.insertId, usuario_id, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear pedido' });
  }
});

// PUT actualizar estado del pedido
router.put('/api/pedidos/:id/estado', async (req, res) => {
  try {
    const { estado_id } = req.body || {};
    if (!estado_id) {
      return res.status(400).json({ error: 'Falta estado_id' });
    }
    const [result] = await pool.query('UPDATE pedidos SET estado_id = ? WHERE id = ?', [estado_id, req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Pedido no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar estado' });
  }
});

module.exports = router;
