const express = require('express');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
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

function calculateCartTotals(cart) {
  let totalCurr = 0;
  for (const item of cart) {
    const qty = parseInt(item.quantity || 1);
    const unit = parseFloat(item.price || 0);
    totalCurr += unit * qty;
  }
  const subtotalCurr = totalCurr / 1.21;
  const taxCurr = totalCurr - subtotalCurr;
  return { totalCurr, subtotalCurr, taxCurr };
}

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

router.get('/stripe-config', (req, res) => {
  return res.json({ ok: true, publicKey: process.env.STRIPE_PUBLIC_KEY || '' });
});

router.post('/pay', async (req, res) => {
  const { paymentMethodId, cart, customerData, currency } = req.body;

  try {
    if (!paymentMethodId || !cart || !customerData) {
      return res.json({ ok: false, error: 'Datos incompletos' });
    }

    // Calculate totals from cart items
    // Los precios se cobran en CHF. El total = suma de item.price sin conversión.
    const selectedCurrency = 'chf';

    // Debug: log carrito recibido
    console.log('🧾 Carrito recibido:', cart.map(i => ({ id: i.id, name: i.name, qty: i.quantity, price: i.price })));

    const { totalCurr, subtotalCurr, taxCurr } = calculateCartTotals(cart);
    // Debug: log totales
    console.log(`💶 Moneda seleccionada: ${selectedCurrency.toUpperCase()} | Total calculado: ${totalCurr.toFixed(2)}`);

    // Desglose informativo para emails/factura (sin afectar al cobro)
    console.log(`📊 Desglose (informativo): Base=${subtotalCurr.toFixed(2)} IVA=${taxCurr.toFixed(2)} TOTAL=${totalCurr.toFixed(2)}`);

    // Determine currency
    const amount = Math.round(totalCurr * 100);

    // Create payment intent with Stripe
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount, // smallest unit
      currency: 'chf',
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

    const { orderId } = await createOrderFromCart({
      cart,
      customerData,
      totalCurr,
      selectedCurrency,
      paymentIntentId: paymentIntent.id,
      paymentMethodType: paymentIntent.payment_method_types?.[0]
    });

    console.log(`✓ Proceso completado para pedido #${orderId}`);
    res.json({ ok: true, orderId });

  } catch (err) {
    console.error('Payment error:', err);
    res.json({ ok: false, error: err.message || 'Error al procesar el pago' });
  }
});

router.post('/create-payment-intent', async (req, res) => {
  const { cart, customerData } = req.body;

  try {
    if (!cart || !Array.isArray(cart) || cart.length === 0) {
      return res.json({ ok: false, error: 'Carrito vacío' });
    }

    const selectedCurrency = 'chf';
    const { totalCurr, subtotalCurr, taxCurr } = calculateCartTotals(cart);

    console.log(`💶 Crear PI | Moneda: ${selectedCurrency.toUpperCase()} | Total: ${totalCurr.toFixed(2)}`);
    console.log(`📊 Desglose (informativo): Base=${subtotalCurr.toFixed(2)} IVA=${taxCurr.toFixed(2)} TOTAL=${totalCurr.toFixed(2)}`);

    const amount = Math.round(totalCurr * 100);

    const currencyCode = 'chf';
    const paymentMethodTypes = ['paypal', 'twint', 'amazon_pay', 'card'];

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: currencyCode,
      payment_method_types: paymentMethodTypes,
      description: `Pedido LITUM3D - ${customerData?.name || 'Cliente'}`,
      receipt_email: customerData?.email || undefined,
      metadata: {
        customer_name: customerData?.name || '',
        customer_email: customerData?.email || '',
        customer_phone: customerData?.phone || '',
        currency: selectedCurrency
      }
    });

    return res.json({
      ok: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id
    });
  } catch (err) {
    console.error('Create PI error:', err);
    return res.json({ ok: false, error: err.message || 'Error al iniciar pago' });
  }
});

router.post('/confirm-payment', async (req, res) => {
  const { paymentIntentId, cart, customerData } = req.body;

  try {
    if (!paymentIntentId || !cart || !customerData) {
      return res.json({ ok: false, error: 'Datos incompletos' });
    }

    const selectedCurrency = 'chf';
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (!paymentIntent || paymentIntent.status !== 'succeeded') {
      return res.json({ ok: false, error: 'Pago no confirmado' });
    }

    const { totalCurr } = calculateCartTotals(cart);
    const expectedAmount = Math.round(totalCurr * 100);
    const expectedCurrency = 'chf';

    if (paymentIntent.amount !== expectedAmount || paymentIntent.currency !== expectedCurrency) {
      return res.json({ ok: false, error: 'El total del pago no coincide' });
    }

    const finalCustomerData = {
      name: customerData?.name || paymentIntent.metadata?.customer_name || null,
      email: customerData?.email || paymentIntent.metadata?.customer_email || paymentIntent.receipt_email || null,
      phone: customerData?.phone || paymentIntent.metadata?.customer_phone || null,
      address: customerData?.address || null,
      city: customerData?.city || null,
      zip: customerData?.zip || null,
      country: customerData?.country || null
    };

    const { orderId } = await createOrderFromCart({
      cart,
      customerData: finalCustomerData,
      totalCurr,
      selectedCurrency,
      paymentIntentId: paymentIntent.id,
      paymentMethodType: paymentIntent.payment_method_types?.[0]
    });

    return res.json({ ok: true, orderId });
  } catch (err) {
    console.error('Confirm payment error:', err);
    return res.json({ ok: false, error: err.message || 'Error al confirmar pago' });
  }
});

async function createOrderFromCart({ cart, customerData, totalCurr, selectedCurrency, paymentIntentId, paymentMethodType }) {
  const conn = await pool.getConnection();
  try {
    const [existing] = await conn.query(
      'SELECT id FROM pedidos WHERE notas LIKE ?',
      [`%Stripe ID: ${paymentIntentId}%`]
    );
    if (existing.length) {
      return { orderId: existing[0].id, alreadyProcessed: true };
    }

    await conn.beginTransaction();

    // Insert into pedidos
    const [orderResult] = await conn.query(
      'INSERT INTO pedidos (usuario_id, estado_id, total, customer_name, customer_email, customer_phone, customer_address, customer_city, customer_zip, customer_country, notas) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        null,
        1,
        totalCurr,
        customerData?.name || null,
        customerData?.email || null,
        customerData?.phone || null,
        customerData?.address || null,
        customerData?.city || null,
        customerData?.zip || null,
        customerData?.country || null,
        `Moneda: ${selectedCurrency.toUpperCase()}`
      ]
    );

    const orderId = orderResult.insertId;

    // Insert items into detalle_pedidos
    for (const item of cart) {
      const rawModelId = item.modelId ?? item.model_id ?? item.modelID ?? null;
      let safeModelId = null;
      if (rawModelId !== undefined && rawModelId !== null && rawModelId !== '') {
        const parsed = parseInt(rawModelId, 10);
        if (!Number.isNaN(parsed)) {
          const [modelRows] = await conn.query(
            'SELECT id FROM product_models WHERE id = ? LIMIT 1',
            [parsed]
          );
          if (modelRows.length) safeModelId = parsed;
        }
      }

      // Guardar variantes seleccionadas si existen (baseId, shapeId)
      let variantesSeleccionadas = null;
      if (item.baseId || item.shapeId) {
        variantesSeleccionadas = JSON.stringify({ baseId: item.baseId || null, shapeId: item.shapeId || null });
      }
      const [detailResult] = await conn.query(
        'INSERT INTO detalle_pedidos (pedido_id, producto_id, modelo_id, cantidad, precio_unitario, personalizacion_notas, variantes_seleccionadas) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [orderId, item.id, safeModelId, item.quantity, item.price, item.notes || null, variantesSeleccionadas]
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
    const methodTag = paymentMethodType ? ` | Método: ${paymentMethodType}` : '';
    await conn.query(
      'UPDATE pedidos SET notas = CONCAT(IFNULL(notas, \'\'), ?, " | Stripe ID: ", ?) WHERE id = ?',
      [methodTag, paymentIntentId, orderId]
    );

    await conn.commit();

    console.log(`📦 Pedido #${orderId} creado en BD`);
    console.log(`📧 Intentando enviar emails...`);

    // Send confirmation emails
    await sendConfirmationEmails(orderId, customerData, cart, totalCurr, selectedCurrency);

    return { orderId, alreadyProcessed: false };
  } catch (err) {
    try {
      await conn.rollback();
    } catch (e) {
      // ignore rollback errors
    }
    throw err;
  } finally {
    conn.release();
  }
}

async function sendConfirmationEmails(orderId, customerData, cart, total, selectedCurrency) {
  try {
    const baseUrl = process.env.PUBLIC_BASE_URL || process.env.BASE_URL || 'https://litum3d.com';
    const logoUrl = process.env.LOGO_URL
      ? process.env.LOGO_URL
      : `${baseUrl.replace(/\/$/, '')}/img/logos/lineal.logo.png`;
    const symbol = selectedCurrency === 'chf' ? 'CHF' : '€';
    const cartHTML = cart.map(item => {
      const imageLinks = Array.isArray(item.images) && item.images.length
        ? `<div style="margin-top:6px;">${item.images.map(img => {
            const raw = typeof img === 'string' ? img : (img.url || img.filename || '');
            if (!raw) return '';
            const url = raw.startsWith('http') ? raw : `${baseUrl.replace(/\/$/, '')}${raw.startsWith('/') ? '' : '/'}${raw}`;
            return `<a href="${escapeHtml(url)}" style="color:#e0ad61; text-decoration:underline; font-size:12px;" target="_blank">Ver imagen</a>`;
          }).filter(Boolean).join(' · ')}
          </div>`
        : '';

      return `
      <tr>
        <td style="padding: 8px; border-bottom: 1px solid #ddd;">
          ${escapeHtml(item.name)}${item.modelName ? ' · ' + escapeHtml(item.modelName) : ''}
          ${item.notes ? `<br><small style="color:#666;">Notas: ${escapeHtml(item.notes)}</small>` : ''}
          ${Array.isArray(item.images) && item.images.length ? `<br><small style="color:#666;">Imágenes: ${item.images.length}</small></small>` : ''}
          ${imageLinks}
        </td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: center;">${item.quantity}</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">${symbol}${item.price.toFixed(2)}</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">${symbol}${(item.price * item.quantity).toFixed(2)}</td>
      </tr>
    `;
    }).join('');

    const subtotal = total / 1.21;
    const tax = total - subtotal;

    // Email to customer
    const customerEmailHTML = `
      <div style="background:#0f172a; padding:32px 16px; font-family:'Segoe UI',Arial,sans-serif; color:#e5e7eb;">
        <div style="max-width:680px; margin:0 auto; background:#111827; border:1px solid rgba(255,255,255,0.08); border-radius:16px; box-shadow:0 20px 60px rgba(0,0,0,0.45); overflow:hidden;">
          <div style="background:linear-gradient(135deg,#0b1020,#1a1a2e); padding:18px 24px; display:flex; align-items:center; gap:12px;">
            <div style="background:#ffffff; padding:6px 10px; border-radius:10px; display:flex; align-items:center;">
              <img src="${logoUrl}" alt="LITUM3D" style="height:36px; width:auto; display:block;" />
            </div>
            <div>
              <div style="font-size:18px; font-weight:700; color:#fff;">Pedido confirmado</div>
              <div style="opacity:0.8; font-size:13px; color:#cbd5f5;">#${orderId} · Pago recibido</div>
            </div>
          </div>

          <div style="padding:24px; line-height:1.6;">
            <p style="margin:0 0 8px 0; font-size:15px; color:#e5e7eb;">Hola <strong>${escapeHtml(customerData.name)}</strong>,</p>
            <p style="margin:0; color:#b6c2d9;">Gracias por tu compra en LITUM3D. Estamos preparando tu pedido.</p>

            <div style="margin:18px 0; padding:14px 16px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:12px;">
              <div style="font-weight:700; font-size:14px; color:#f8fafc;">Resumen de pago</div>
              <div style="margin-top:8px; display:flex; justify-content:space-between; color:#cbd5f5; font-size:14px;">
                <span>Base (sin IVA)</span><span>${symbol}${subtotal.toFixed(2)}</span>
              </div>
              <div style="margin-top:4px; display:flex; justify-content:space-between; color:#cbd5f5; font-size:14px;">
                <span>IVA (21%)</span><span>${symbol}${tax.toFixed(2)}</span>
              </div>
              <div style="margin-top:10px; display:flex; justify-content:space-between; font-weight:800; font-size:16px; color:#e0ad61;">
                <span>TOTAL</span><span>${symbol}${total.toFixed(2)}</span>
              </div>
            </div>

            <div style="margin-top:16px;">
              <div style="font-weight:700; font-size:14px; color:#f8fafc; margin-bottom:10px;">Detalles del pedido</div>
              <table style="width:100%; border-collapse:collapse; border:1px solid rgba(255,255,255,0.08);">
                <thead>
                  <tr style="background:rgba(255,255,255,0.04); border-bottom:1px solid rgba(255,255,255,0.08);">
                    <th style="padding:10px; text-align:left; font-size:12px; color:#cbd5f5;">Producto</th>
                    <th style="padding:10px; text-align:center; font-size:12px; color:#cbd5f5;">Cant.</th>
                    <th style="padding:10px; text-align:right; font-size:12px; color:#cbd5f5;">Precio</th>
                    <th style="padding:10px; text-align:right; font-size:12px; color:#cbd5f5;">Subtotal</th>
                  </tr>
                </thead>
                <tbody>
                  ${cartHTML}
                </tbody>
              </table>
            </div>

            <div style="margin-top:18px; padding:12px 14px; background:rgba(224,173,97,0.08); border:1px solid rgba(224,173,97,0.35); border-radius:12px;">
              <div style="font-weight:700; color:#f0c070; font-size:14px;">Datos de envío</div>
              <div style="margin-top:6px; color:#d0d5e0; font-size:14px; line-height:1.5;">
                ${escapeHtml(customerData.name)}<br>
                ${escapeHtml(customerData.address)}<br>
                ${escapeHtml(customerData.zip)} ${escapeHtml(customerData.city)}<br>
                Teléfono: ${escapeHtml(customerData.phone)}
              </div>
            </div>

            <p style="margin-top:18px; color:#b6c2d9; font-size:13px;">Si tienes dudas, responde a este correo o contáctanos y te ayudaremos.</p>

            <div style="margin-top:14px;">
              <a href="${baseUrl}" style="display:inline-block; padding:12px 18px; background:linear-gradient(135deg,#e0ad61,#f0c070); color:#1a1a2e; border-radius:10px; text-decoration:none; font-weight:800; font-size:14px;">Ir a LITUM3D</a>
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

    // Build attachments for admin (uploaded images)
    const attachments = [];
    for (const item of cart) {
      const images = Array.isArray(item.images) ? item.images : [];
      for (const img of images) {
        const raw = typeof img === 'string' ? img : (img.url || img.filename || '');
        if (!raw) continue;
        const localPath = raw.startsWith('/uploads/')
          ? path.join(__dirname, '..', raw)
          : path.join(__dirname, '..', 'uploads', 'custom', raw);
        if (fs.existsSync(localPath)) {
          attachments.push({
            filename: path.basename(localPath),
            path: localPath
          });
        }
      }
    }

    // Send admin email (with attachments)
    await transporter.sendMail({
      from: process.env.SMTP_USER || 'noreply@litum3d.com',
      to: process.env.ADMIN_EMAIL || 'contact@litum3d.com',
      subject: `Nuevo Pedido Pagado #${orderId} - ${customerData.name}`,
      html: adminEmailHTML,
      attachments
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
