const express = require('express');
const { pool } = require('../config/db');
const requireAuth = require('../middleware/requireAuth');
const { csrfProtection } = require('../middleware/csrf');

const router = express.Router();

// P0-SECURITY-01 (sección 11): ninguna ruta de este archivo es "anónima por
// diseño" -- expone PII de clientes (email/teléfono/dirección) y permite
// mutarla. No hay ningún consumidor real en el frontend (auditado: público/js
// y views/ no llaman a /api/usuarios), así que protegerla no puede romper
// ningún flujo existente, pero se cierra igualmente porque un endpoint sin
// auth que lista/edita/borra usuarios es un riesgo por sí mismo.

// GET todos los usuarios (sin contraseña)
router.get('/api/usuarios', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, nombre, email, telefono, direccion, activo, created_at FROM usuarios WHERE activo = TRUE');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
});

// GET usuario por ID
router.get('/api/usuarios/:id', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, nombre, email, telefono, direccion, activo FROM usuarios WHERE id = ? AND activo = TRUE', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener usuario' });
  }
});

// POST crear usuario
router.post('/api/usuarios', requireAuth, csrfProtection, async (req, res) => {
  try {
    const { nombre, email, telefono, direccion, contraseña } = req.body || {};
    if (!nombre || !email || !contraseña) {
      return res.status(400).json({ error: 'Falta nombre, email o contraseña' });
    }
    const [result] = await pool.query(
      'INSERT INTO usuarios (nombre, email, telefono, direccion, contraseña) VALUES (?, ?, ?, ?, ?)',
      [nombre, email, telefono || null, direccion || null, contraseña]
    );
    res.status(201).json({ id: result.insertId, nombre, email });
  } catch (err) {
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(409).json({ error: 'Email ya existe' });
    } else {
      res.status(500).json({ error: 'Error al crear usuario' });
    }
  }
});

// PUT actualizar usuario
router.put('/api/usuarios/:id', requireAuth, csrfProtection, async (req, res) => {
  try {
    const { nombre, email, telefono, direccion } = req.body || {};
    if (!nombre && !email && !telefono && !direccion) {
      return res.status(400).json({ error: 'Sin campos para actualizar' });
    }
    const fields = [];
    const values = [];
    if (nombre) { fields.push('nombre = ?'); values.push(nombre); }
    if (email) { fields.push('email = ?'); values.push(email); }
    if (telefono) { fields.push('telefono = ?'); values.push(telefono); }
    if (direccion) { fields.push('direccion = ?'); values.push(direccion); }
    values.push(req.params.id);
    const [result] = await pool.query(`UPDATE usuarios SET ${fields.join(', ')} WHERE id = ?`, values);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar usuario' });
  }
});

// DELETE desactivar usuario (soft delete)
router.delete('/api/usuarios/:id', requireAuth, csrfProtection, async (req, res) => {
  try {
    const [result] = await pool.query('UPDATE usuarios SET activo = FALSE WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al desactivar usuario' });
  }
});

module.exports = router;
