const express = require('express');
const { pool } = require('../config/db');

const router = express.Router();

// GET todos los estados
router.get('/api/estados', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM estado_pedido ORDER BY id');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener estados' });
  }
});

// POST crear nuevo estado (admin)
router.post('/api/estados', async (req, res) => {
  try {
    const { nombre, descripcion } = req.body || {};
    if (!nombre) {
      return res.status(400).json({ error: 'Falta nombre' });
    }
    const [result] = await pool.query(
      'INSERT INTO estado_pedido (nombre, descripcion) VALUES (?, ?)',
      [nombre, descripcion || null]
    );
    res.status(201).json({ id: result.insertId, nombre });
  } catch (err) {
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: 'Estado ya existe' });
    } else {
      res.status(500).json({ error: 'Error al crear estado' });
    }
  }
});

module.exports = router;
