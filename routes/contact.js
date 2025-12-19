const express = require('express');
const nodemailer = require('nodemailer');

const router = express.Router();

router.post('/api/contact', async (req, res) => {
  try {
    const { name, email, message } = req.body || {};
    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE) === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    const info = await transporter.sendMail({
      from: `LITUM3D Contact <${process.env.SMTP_USER}>`,
      to: process.env.CONTACT_TO,
      subject: `Nuevo mensaje de ${name}`,
      replyTo: email,
      text: message,
      html: `<p><strong>Nombre:</strong> ${name}</p><p><strong>Email:</strong> ${email}</p><p>${message}</p>`,
    });

    res.json({ ok: true, id: info.messageId });
  } catch (err) {
    console.error('Contact form error:', err);
    res.status(500).json({ error: 'Email failed' });
  }
});

module.exports = router;
