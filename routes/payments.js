const express = require('express');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const { pool } = require('../config/db');

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_51QsLCsJqC7yL3rEX92K4z1L6R7Z9qW8vE5tY2uO3pA4bB6cC7dD8eE9fF0gG1hH2');

// Email transporter configuration
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER || 'ruben@litum3d.com',
    pass: process.env.SMTP_PASS || ''
  }
});

router.post('/pay', async (req, res) => {
  const { paymentMethodId, cart, customerData } = req.body;

  try {
    if (!paymentMethodId || !cart || !customerData) {
      return res.json({ ok: false, error: 'Datos incompletos' });
    }

    // Calculate total with tax
    const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const tax = subtotal * 0.21;
    const total = subtotal + tax;

    // Create payment intent with Stripe
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(total * 100), // cents
      currency: 'eur',
      payment_method: paymentMethodId,
      confirm: true,
      description: `Pedido LITUM3D - ${customerData.name}`,
      receipt_email: customerData.email,
      metadata: {
        customer_name: customerData.name,
        customer_email: customerData.email,
        customer_phone: customerData.phone
      }
    });

    if (paymentIntent.status !== 'succeeded') {
      return res.json({ ok: false, error: 'Pago rechazado. Intenta de nuevo.' });
    }

    // Store order in database
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Insert into pedidos
      const [orderResult] = await conn.query(
        'INSERT INTO pedidos (usuario_id, estado_id, total_pedido, fecha_pedido) VALUES (?, ?, ?, NOW())',
        [null, 1, total] // null usuario_id = guest, 1 = estado_pedido "Pendiente"
      );

      const orderId = orderResult.insertId;

      // Insert items into detalle_pedidos
      for (const item of cart) {
        await conn.query(
          'INSERT INTO detalle_pedidos (pedido_id, producto_id, cantidad, precio_unitario) VALUES (?, ?, ?, ?)',
          [orderId, item.id, item.quantity, item.price]
        );
      }

      // Store payment intent ID for reference
      await conn.query(
        'UPDATE pedidos SET nota_pedido = ? WHERE id = ?',
        [`Stripe ID: ${paymentIntent.id}`, orderId]
      );

      await conn.commit();

      // Send confirmation emails
      await sendConfirmationEmails(orderId, customerData, cart, total);

      res.json({ ok: true, orderId });
    } finally {
      conn.release();
    }

  } catch (err) {
    console.error('Payment error:', err);
    res.json({ ok: false, error: err.message || 'Error al procesar el pago' });
  }
});

async function sendConfirmationEmails(orderId, customerData, cart, total) {
  try {
    const cartHTML = cart.map(item => `
      <tr>
        <td style="padding: 8px; border-bottom: 1px solid #ddd;">${escapeHtml(item.name)}</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: center;">${item.quantity}</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">€${item.price.toFixed(2)}</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">€${(item.price * item.quantity).toFixed(2)}</td>
      </tr>
    `).join('');

    const subtotal = total / 1.21;
    const tax = total - subtotal;

    // Email to customer
    const customerEmailHTML = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a1a2e;">¡Pedido Confirmado! 🎉</h2>
        <p>Hola <strong>${escapeHtml(customerData.name)}</strong>,</p>
        <p>Tu pedido #${orderId} ha sido recibido y pagado exitosamente.</p>

        <h3 style="margin-top: 20px; color: #e0ad61;">Detalles del Pedido</h3>
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background-color: #f0f0f0;">
              <th style="padding: 10px; text-align: left;">Producto</th>
              <th style="padding: 10px; text-align: center;">Cantidad</th>
              <th style="padding: 10px; text-align: right;">Precio</th>
              <th style="padding: 10px; text-align: right;">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            ${cartHTML}
          </tbody>
        </table>

        <div style="text-align: right; margin-top: 20px;">
          <p><strong>Subtotal:</strong> €${subtotal.toFixed(2)}</p>
          <p><strong>IVA (21%):</strong> €${tax.toFixed(2)}</p>
          <p style="font-size: 18px; color: #e0ad61;"><strong>TOTAL: €${total.toFixed(2)}</strong></p>
        </div>

        <h3 style="margin-top: 20px; color: #e0ad61;">Datos de Envío</h3>
        <p>
          ${escapeHtml(customerData.name)}<br>
          ${escapeHtml(customerData.address)}<br>
          ${escapeHtml(customerData.zip)} ${escapeHtml(customerData.city)}<br>
          Teléfono: ${escapeHtml(customerData.phone)}
        </p>

        <p style="margin-top: 20px; color: #666;">
          <small>Recibirás actualizaciones sobre tu pedido en este email. Si tienes dudas, contáctanos.</small>
        </p>

        <p style="margin-top: 30px; color: #1a1a2e;">
          <strong>LITUM3D</strong><br>
          <small>Premium 3D Litofanías</small>
        </p>
      </div>
    `;

    // Email to admin
    const adminEmailHTML = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a1a2e;">¡Nuevo Pedido Pagado! #${orderId}</h2>

        <h3 style="color: #e0ad61;">Cliente</h3>
        <p>
          Nombre: <strong>${escapeHtml(customerData.name)}</strong><br>
          Email: <strong>${escapeHtml(customerData.email)}</strong><br>
          Teléfono: ${escapeHtml(customerData.phone)}<br>
          Dirección: ${escapeHtml(customerData.address)}<br>
          ${escapeHtml(customerData.zip)} ${escapeHtml(customerData.city)}
        </p>

        <h3 style="margin-top: 20px; color: #e0ad61;">Artículos</h3>
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background-color: #f0f0f0;">
              <th style="padding: 10px; text-align: left;">Producto</th>
              <th style="padding: 10px; text-align: center;">Cantidad</th>
              <th style="padding: 10px; text-align: right;">Precio</th>
              <th style="padding: 10px; text-align: right;">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            ${cartHTML}
          </tbody>
        </table>

        <div style="text-align: right; margin-top: 20px;">
          <p><strong>Subtotal:</strong> €${subtotal.toFixed(2)}</p>
          <p><strong>IVA (21%):</strong> €${tax.toFixed(2)}</p>
          <p style="font-size: 18px; color: #e0ad61;"><strong>TOTAL: €${total.toFixed(2)}</strong></p>
        </div>

        <p style="margin-top: 20px; color: #666; background-color: #f9f9f9; padding: 10px;">
          <small><strong>Acción necesaria:</strong> Prepara el envío y actualiza el estado del pedido.</small>
        </p>
      </div>
    `;

    // Send customer email
    await transporter.sendMail({
      from: process.env.SMTP_USER || 'noreply@litum3d.com',
      to: customerData.email,
      subject: `Confirmación de Pedido #${orderId} - LITUM3D`,
      html: customerEmailHTML
    });

    // Send admin email
    await transporter.sendMail({
      from: process.env.SMTP_USER || 'noreply@litum3d.com',
      to: process.env.ADMIN_EMAIL || 'contact@litum3d.com',
      subject: `Nuevo Pedido Pagado #${orderId} - ${customerData.name}`,
      html: adminEmailHTML
    });

    console.log(`✓ Emails enviados para pedido #${orderId}`);
  } catch (err) {
    console.error('Email sending error:', err);
  }
}

function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}

module.exports = router;
