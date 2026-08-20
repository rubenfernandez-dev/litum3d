const express = require('express');
const { pool } = require('../config/db');
const requireAuth = require('../middleware/requireAuth');
const { csrfProtection } = require('../middleware/csrf');
const { getTransporter, getFromAddress, sanitizeHeaderValue } = require('../services/mailer');
const { escapeHtml } = require('../services/email-template');

const router = express.Router();

// GET contactos (P0-SECURITY-01, sección 11: PII de clientes -- solo admin)
router.get('/api/contactos', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM contacto ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener contactos' });
  }
});

// GET contacto por ID
router.get('/api/contactos/:id', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM contacto WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Contacto no encontrado' });
    // Marcar como leído
    await pool.query('UPDATE contacto SET leido = TRUE WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener contacto' });
  }
});

// POST crear contacto (desde formulario web)
router.post('/api/contact', async (req, res) => {
  try {
    const { name, email, asunto, message } = req.body || {};
    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Falta nombre, email o mensaje' });
    }

    // Guardar en BD
    const [result] = await pool.query(
      'INSERT INTO contacto (nombre, email, asunto, mensaje) VALUES (?, ?, ?, ?)',
      [name, email, asunto || 'Sin asunto', message]
    );

    // Enviar email si está configurado
    if (process.env.SMTP_HOST && process.env.SMTP_USER) {
      try {
        const transporter = getTransporter();

        // Reply-To = email del visitante (sección 10 del informe de
        // saneamiento de emails): LITUM3D pulsa "Responder" -> responde
        // directamente al cliente, nunca a sí mismo.
        await transporter.sendMail({
          from: getFromAddress('LITUM3D Contact'),
          to: process.env.CONTACT_TO,
          subject: `Nuevo mensaje de ${sanitizeHeaderValue(name)}`,
          replyTo: email,
          text: message,
          html: `<p><strong>Nombre:</strong> ${escapeHtml(name)}</p><p><strong>Email:</strong> ${escapeHtml(email)}</p><p><strong>Asunto:</strong> ${escapeHtml(asunto)}</p><p>${escapeHtml(message)}</p>`,
        });
      } catch (emailErr) {
        console.warn('Email no enviado:', emailErr.message);
        // Continuamos sin fallar
      }
    }

    res.status(201).json({ ok: true, id: result.insertId });
  } catch (err) {
    console.error('Contact form error:', err);
    res.status(500).json({ error: 'Error al procesar contacto' });
  }
});

// PUT marcar contacto como respondido
router.put('/api/contactos/:id/respondido', requireAuth, csrfProtection, async (req, res) => {
  try {
    const [result] = await pool.query('UPDATE contacto SET respondido = TRUE WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Contacto no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar contacto' });
  }
});

module.exports = router;
