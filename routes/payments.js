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

    // Calculate totals from cart items
    // Los precios están siempre en EUR. El total = suma de item.price sin conversión.
    // currency solo indica en qué moneda mostrar (EUR o CHF) pero no afecta el cálculo.
    const selectedCurrency = (currency || 'eur').toLowerCase();

    // Debug: log carrito recibido
    console.log('🧾 Carrito recibido:', cart.map(i => ({ id: i.id, name: i.name, qty: i.quantity, price: i.price })));

    let totalCurr = 0;
    for (const item of cart) {
      const qty = parseInt(item.quantity || 1);
      const unit = parseFloat(item.price || 0);
      totalCurr += unit * qty;
    }
    // Debug: log totales
    console.log(`💶 Moneda seleccionada: ${selectedCurrency.toUpperCase()} | Total calculado: ${totalCurr.toFixed(2)}`);

    // Desglose informativo para emails/factura (sin afectar al cobro)
    const subtotalCurr = totalCurr / 1.21;
    const taxCurr = totalCurr - subtotalCurr;
    console.log(`📊 Desglose (informativo): Base=${subtotalCurr.toFixed(2)} IVA=${taxCurr.toFixed(2)} TOTAL=${totalCurr.toFixed(2)}`);

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
        // Guardar variantes seleccionadas si existen (baseId, shapeId)
        let variantesSeleccionadas = null;
        if (item.baseId || item.shapeId) {
          variantesSeleccionadas = JSON.stringify({ baseId: item.baseId || null, shapeId: item.shapeId || null });
        }
        const [detailResult] = await conn.query(
          'INSERT INTO detalle_pedidos (pedido_id, producto_id, modelo_id, cantidad, precio_unitario, personalizacion_notas, variantes_seleccionadas) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [orderId, item.id, item.modelId || null, item.quantity, item.price, item.notes || null, variantesSeleccionadas]
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
      <div style="background:#f5f7fb; padding:24px; font-family:'Segoe UI',Arial,sans-serif; color:#101828;">
        <div style="max-width:640px; margin:0 auto; background:#ffffff; border:1px solid #e9eef5; border-radius:12px; box-shadow:0 12px 32px rgba(16,24,40,0.08); overflow:hidden;">
          <div style="background:linear-gradient(135deg,#1a1a2e,#2d2f4a); color:#fff; padding:18px 24px;">
            <div style="font-size:20px; font-weight:700;">Pedido confirmado</div>
            <div style="opacity:0.9; font-size:13px;">#${orderId} · Pago recibido</div>
          </div>

          <div style="padding:22px 24px; line-height:1.6;">
            <p style="margin:0 0 8px 0; font-size:15px;">Hola <strong>${escapeHtml(customerData.name)}</strong>,</p>
            <p style="margin:0; color:#475467;">Gracias por tu compra en LITUM3D. Estamos preparando tu pedido.</p>

            <div style="margin:18px 0; padding:14px 16px; background:#f8fafc; border:1px solid #e9eef5; border-radius:10px;">
              <div style="font-weight:700; font-size:14px; color:#0f172a;">Resumen de pago</div>
              <div style="margin-top:8px; display:flex; justify-content:space-between; color:#475467; font-size:14px;">
                <span>Base (sin IVA)</span><span>${symbol}${subtotal.toFixed(2)}</span>
              </div>
              <div style="margin-top:4px; display:flex; justify-content:space-between; color:#475467; font-size:14px;">
                <span>IVA (21%)</span><span>${symbol}${tax.toFixed(2)}</span>
              </div>
              <div style="margin-top:10px; display:flex; justify-content:space-between; font-weight:800; font-size:16px; color:#1a1a2e;">
                <span>TOTAL</span><span>${symbol}${total.toFixed(2)}</span>
              </div>
            </div>

            <div style="margin-top:16px;">
              <div style="font-weight:700; font-size:14px; color:#0f172a; margin-bottom:10px;">Detalles del pedido</div>
              <table style="width:100%; border-collapse:collapse; border:1px solid #e9eef5;">
                <thead>
                  <tr style="background:#f8fafc; border-bottom:1px solid #e9eef5;">
                    <th style="padding:10px; text-align:left; font-size:13px; color:#344054;">Producto</th>
                    <th style="padding:10px; text-align:center; font-size:13px; color:#344054;">Cant.</th>
                    <th style="padding:10px; text-align:right; font-size:13px; color:#344054;">Precio</th>
                    <th style="padding:10px; text-align:right; font-size:13px; color:#344054;">Subtotal</th>
                  </tr>
                </thead>
                <tbody>
                  ${cartHTML}
                </tbody>
              </table>
            </div>

            <div style="margin-top:18px; padding:12px 14px; background:#fff8ed; border:1px solid #f4e3c3; border-radius:10px;">
              <div style="font-weight:700; color:#8b5a1e; font-size:14px;">Datos de envío</div>
              <div style="margin-top:6px; color:#6b7280; font-size:14px; line-height:1.5;">
                ${escapeHtml(customerData.name)}<br>
                ${escapeHtml(customerData.address)}<br>
                ${escapeHtml(customerData.zip)} ${escapeHtml(customerData.city)}<br>
                Teléfono: ${escapeHtml(customerData.phone)}
              </div>
            </div>

            <p style="margin-top:18px; color:#475467; font-size:13px;">Si tienes dudas, responde a este correo o contáctanos y te ayudaremos.</p>

            <div style="margin-top:14px;">
              <a href="https://litum3d.com" style="display:inline-block; padding:12px 18px; background:#1a1a2e; color:#fff; border-radius:8px; text-decoration:none; font-weight:700; font-size:14px;">Ir a LITUM3D</a>
            </div>
          </div>
        </div>
      </div>
    `;

    // Email to admin
    const debugLines = cart.map(i => `${escapeHtml(i.name)} x${i.quantity} = ${(i.price * i.quantity).toFixed(2)}`).join(' | ');
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
          <p><strong>Base (sin IVA):</strong> ${symbol}${subtotal.toFixed(2)}</p>
          <p><strong>IVA (21%):</strong> ${symbol}${tax.toFixed(2)}</p>
          <p style="font-size: 18px; color: #e0ad61;"><strong>TOTAL: ${symbol}${total.toFixed(2)}</strong></p>
        </div>

        <p style="margin-top: 12px; color: #888; background:#f6f6f6; padding:8px; border-radius:6px;">
          <small><strong>DEBUG:</strong> Moneda=${selectedCurrency.toUpperCase()} | Líneas: ${debugLines} | Suma líneas=${total.toFixed(2)}</small>
        </p>

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
