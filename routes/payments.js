const express = require('express');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const { pool } = require('../config/db');

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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

// FX rate cache (EUR→CHF)
let eurChfCache = { rate: null, updatedAt: 0 };
const FX_CACHE_TTL_MS = parseInt(process.env.FX_CACHE_TTL_MS || '21600000'); // 6h default

async function getEurToChfRate() {
  const now = Date.now();
  if (eurChfCache.rate && (now - eurChfCache.updatedAt) < FX_CACHE_TTL_MS) {
    return eurChfCache.rate;
  }
  try {
    // Frankfurter (ECB) API
    const url = 'https://api.frankfurter.app/latest?from=EUR&to=CHF';
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`FX API ${resp.status}`);
    const data = await resp.json();
    const rate = parseFloat(data?.rates?.CHF);
    if (Number.isFinite(rate) && rate > 0) {
      eurChfCache = { rate, updatedAt: now };
      return rate;
    }
    throw new Error('Invalid FX rate');
  } catch (err) {
    const fallback = parseFloat(process.env.EXCHANGE_EUR_CHF || '1.00');
    return Number.isFinite(fallback) && fallback > 0 ? fallback : 1.00;
  }
}

// Public endpoint to read current EUR→CHF rate
router.get('/fx/eur-chf', async (req, res) => {
  try {
    const rate = await getEurToChfRate();
    return res.json({ ok: true, rate, updatedAt: eurChfCache.updatedAt });
  } catch (e) {
    return res.json({ ok: false, error: e.message || 'FX error' });
  }
});

router.post('/pay', async (req, res) => {
  const { paymentMethodId, cart, customerData, currency } = req.body;

  try {
    if (!paymentMethodId || !cart || !customerData) {
      return res.json({ ok: false, error: 'Datos incompletos' });
    }

    // Calculate totals from base and extras
    const selectedCurrency = (currency || 'eur').toLowerCase();
    const eurToChf = selectedCurrency === 'chf' ? await getEurToChfRate() : 1.0;

    let subtotalBaseEur = 0; // base (product + modelo) in EUR
    let subtotalExtrasCurr = 0; // extras sum in selected currency

    for (const item of cart) {
      const qty = parseInt(item.quantity || 1);
      const baseUnitEur = parseFloat(item.basePrice || 0) + parseFloat(item.priceDelta || 0);
      subtotalBaseEur += baseUnitEur * qty;

      const ex = item.extras || {};
      const extrasUnit = (ex.upscale ? 5 : 0) + (ex.qr ? 5 : 0) + (ex.adapter ? 4 : 0);
      subtotalExtrasCurr += extrasUnit * qty; // already in EUR or CHF by currency choice
    }

    // Convert base to CHF if needed
    const subtotalBaseCurr = selectedCurrency === 'chf' ? (subtotalBaseEur * eurToChf) : subtotalBaseEur;
    const subtotalCurr = subtotalBaseCurr + subtotalExtrasCurr;
    const taxCurr = subtotalCurr * 0.21;
    const totalCurr = subtotalCurr + taxCurr;

    // Determine currency
    const amount = Math.round(totalCurr * 100);

    // Create payment intent with Stripe
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount, // smallest unit
      currency: selectedCurrency === 'chf' ? 'chf' : 'eur',
      payment_method: paymentMethodId,
      confirm: true,
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: 'never'
      },
      description: `Pedido LITUM3D - ${customerData.name}`,
      receipt_email: customerData.email,
      metadata: {
        customer_name: customerData.name,
        customer_email: customerData.email,
        customer_phone: customerData.phone,
        currency: selectedCurrency
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
        'INSERT INTO pedidos (usuario_id, estado_id, total, notas) VALUES (?, ?, ?, ?)',
        [null, 1, totalCurr, `Moneda: ${selectedCurrency.toUpperCase()}`]
      );

      const orderId = orderResult.insertId;

      // Insert items into detalle_pedidos
      for (const item of cart) {
        const [detailResult] = await conn.query(
          'INSERT INTO detalle_pedidos (pedido_id, producto_id, modelo_id, cantidad, precio_unitario, personalizacion_notas) VALUES (?, ?, ?, ?, ?, ?)',
          [orderId, item.id, item.modelId || null, item.quantity, item.price, item.notes || null]
        );

        const detalleId = detailResult.insertId;
        if (Array.isArray(item.images)) {
          const imagesToStore = item.images.slice(0, 3);
          for (const img of imagesToStore) {
            const ruta = typeof img === 'string' ? img : (img.url || img.filename || null);
            if (ruta) {
              await conn.query(
                'INSERT INTO detalle_pedido_imagenes (detalle_pedido_id, ruta) VALUES (?, ?)',
                [detalleId, ruta]
              );
            }
          }
        }
      }

      // Store payment intent ID for reference
      await conn.query(
        'UPDATE pedidos SET notas = CONCAT(IFNULL(notas, \'\'), " | Stripe ID: ", ?) WHERE id = ?',
        [paymentIntent.id, orderId]
      );

      await conn.commit();

      console.log(`📦 Pedido #${orderId} creado en BD`);
      console.log(`📧 Intentando enviar emails...`);

      // Send confirmation emails
      await sendConfirmationEmails(orderId, customerData, cart, totalCurr, selectedCurrency);

      console.log(`✓ Proceso completado para pedido #${orderId}`);
      res.json({ ok: true, orderId });
    } finally {
      conn.release();
    }

  } catch (err) {
    console.error('Payment error:', err);
    res.json({ ok: false, error: err.message || 'Error al procesar el pago' });
  }
});

async function sendConfirmationEmails(orderId, customerData, cart, total, selectedCurrency) {
  try {
    const symbol = selectedCurrency === 'chf' ? 'CHF' : '€';
    const cartHTML = cart.map(item => `
      <tr>
        <td style="padding: 8px; border-bottom: 1px solid #ddd;">
          ${escapeHtml(item.name)}${item.modelName ? ' · ' + escapeHtml(item.modelName) : ''}
          ${item.notes ? `<br><small style="color:#666;">Notas: ${escapeHtml(item.notes)}</small>` : ''}
          ${Array.isArray(item.images) && item.images.length ? `<br><small style="color:#666;">Imágenes: ${item.images.length}</small>` : ''}
        </td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: center;">${item.quantity}</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">${symbol}${item.price.toFixed(2)}</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">${symbol}${(item.price * item.quantity).toFixed(2)}</td>
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
          <p><strong>Subtotal:</strong> ${symbol}${subtotal.toFixed(2)}</p>
          <p><strong>IVA (21%):</strong> ${symbol}${tax.toFixed(2)}</p>
          <p style="font-size: 18px; color: #e0ad61;"><strong>TOTAL: ${symbol}${total.toFixed(2)}</strong></p>
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
          <p><strong>Subtotal:</strong> ${symbol}${subtotal.toFixed(2)}</p>
          <p><strong>IVA (21%):</strong> ${symbol}${tax.toFixed(2)}</p>
          <p style="font-size: 18px; color: #e0ad61;"><strong>TOTAL: ${symbol}${total.toFixed(2)}</strong></p>
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
    console.log(`  Cliente: ${customerData.email}`);
    console.log(`  Admin: ${process.env.ADMIN_EMAIL}`);
  } catch (err) {
    console.error('❌ Email sending error:', err.message);
    console.error('Detalles:', err);
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
