/*
  LITUM3D - Checkout público (P0E-B4B: cutover al flujo canónico seguro).

  A partir de este ticket, ninguna ruta pública puede cobrar un importe
  basado en datos económicos enviados por el navegador (item.price,
  basePrice, priceDelta, extrasTotal, subtotal, total, amount, currency).
  La única autoridad económica es:

    selecciones -> priceCartFromSelections() -> snapshot persistido -> PaymentIntent

  (services/pricing.js -> services/checkout-payment.js -> services/checkout-drafts.js).

  Rutas públicas:
    GET   /api/stripe-config             - clave pública de Stripe.
    GET   /api/pricing-config            - moneda + precios de extras (informativo).
    POST  /api/create-payment-intent     - prepara/reutiliza un checkout_draft + PaymentIntent.
    PATCH /api/checkout-draft/customer-data - actualiza customerData del draft.
    POST  /api/confirm-payment           - finaliza un PaymentIntent succeeded en un pedido.

  /api/pay (creaba un PaymentIntent con amount derivado de item.price del
  cliente) se ha eliminado: cero consumidores reales (auditado, ver informe
  P0E-B4B). calculateCartTotals/createOrderFromCart (legacy, basados en
  cart.item.price del cliente) se han eliminado con ella.

  Factory createPaymentsRouter({...}) permite inyectar los servicios
  (checkoutPayment/checkoutFinalization/stripe) en tests, sin tocar Stripe ni
  BD reales -- mismo patrón de inyección que services/checkout-payment.js.
*/

const express = require('express');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const pricingConfig = require('../config/pricing');
const defaultCheckoutPayment = require('../services/checkout-payment');
const defaultCheckoutFinalization = require('../services/checkout-finalization');
const checkoutDrafts = require('../services/checkout-drafts');
const { PricingValidationError } = require('../services/pricing');

const defaultStripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// Email transporter configuration
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER || 'admin@example.com',
    pass: process.env.SMTP_PASS || ''
  }
});

// --- Validación de body HTTP (allowlist estricta) -----------------------------

class RequestValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RequestValidationError';
    Object.assign(this, details);
  }
}

// Rechaza cualquier campo no esperado en vez de ignorarlo en silencio (mismo
// principio que services/pricing.js#assertAllowedKeys): un campo económico
// "de más" (price/total/currency/...) en el body debe ser un 400 explícito,
// nunca un dato que el servidor decida ignorar silenciosamente sin que el
// cliente lo sepa.
function assertStrictAllowlist(body, allowedKeys, label = 'body') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestValidationError(`${label} debe ser un objeto JSON`);
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new RequestValidationError(`Campo no permitido en ${label}: "${key}"`, { field: key });
    }
  }
}

// --- Mapeo de errores de dominio -> HTTP (sección 27) -------------------------
// Nunca expone SQL/stack traces/access tokens/hashes en la respuesta. El
// mensaje detallado (si contiene valores internos) se registra en el log del
// servidor; la respuesta HTTP usa un mensaje corto y seguro por tipo.

function mapDomainErrorToHttp(err) {
  if (err instanceof RequestValidationError) {
    return { status: 400, code: 'validation_error', message: err.message };
  }
  if (err instanceof PricingValidationError) {
    return { status: 400, code: 'pricing_validation_error', message: err.message };
  }
  if (err instanceof checkoutDrafts.DraftValidationError) {
    return { status: 400, code: 'draft_validation_error', message: err.message };
  }
  if (err instanceof checkoutDrafts.DraftIdempotencyConflictError) {
    return { status: 409, code: 'idempotency_conflict', message: 'La idempotencyKey ya se usó con una selección distinta' };
  }
  if (err instanceof checkoutDrafts.DraftAccessDeniedError) {
    return { status: 403, code: 'access_denied', message: 'Acceso no autorizado' };
  }
  if (err instanceof checkoutDrafts.DraftPaymentIntentConflictError) {
    return { status: 409, code: 'payment_intent_conflict', message: 'Conflicto de PaymentIntent asociado al draft' };
  }
  if (err instanceof checkoutDrafts.DraftStateError) {
    return { status: 409, code: 'state_conflict', message: err.message };
  }
  if (err instanceof checkoutDrafts.DraftNotFoundError) {
    return { status: 404, code: 'draft_not_found', message: 'Checkout no encontrado' };
  }
  if (err && err.name === 'PaymentIntentValidationError') {
    if (err.reason === 'not_succeeded') {
      return { status: 409, code: 'payment_not_succeeded', message: 'El pago todavía no se ha completado' };
    }
    return { status: 422, code: 'payment_integrity_mismatch', message: 'El pago no coincide con el checkout esperado' };
  }
  if (err && err.name === 'FinalizationIntegrityError') {
    return { status: 422, code: 'finalization_integrity_error', message: 'Estado de checkout inconsistente' };
  }
  if (err && err.name === 'CentsRangeError') {
    return { status: 500, code: 'internal_amount_error', message: 'Error interno al procesar el importe' };
  }
  if (err && err.name === 'CheckoutPaymentError') {
    return { status: 500, code: 'checkout_unavailable', message: 'El checkout no está disponible en este momento' };
  }
  // SDK de Stripe: errores de conexión/timeout se marcan como transitorios
  // (502); el resto de StripeError (p.ej. tarjeta rechazada) ya se refleja
  // como un PaymentIntent no succeeded, no como una excepción aquí.
  if (err && typeof err.type === 'string' && err.type.startsWith('Stripe')) {
    if (err.type === 'StripeConnectionError' || err.type === 'StripeAPIError') {
      return { status: 502, code: 'stripe_transient_error', message: 'Error temporal al comunicar con el proveedor de pago' };
    }
    return { status: 502, code: 'stripe_error', message: 'Error al comunicar con el proveedor de pago' };
  }
  return { status: 500, code: 'internal_error', message: 'Error interno' };
}

function sendDomainError(res, err, logContext) {
  const mapped = mapDomainErrorToHttp(err);
  console.error(`[routes/payments] ${logContext}:`, err.name || 'Error', '-', err.message);
  return res.status(mapped.status).json({ ok: false, error: mapped.message, code: mapped.code });
}

// --- DTO público del breakdown (sección 3) -------------------------------------
// Allowlist explícita: NUNCA reenvía access_token_hash, selections_fingerprint,
// customerData ni ningún id/columna interna que el checkout no necesite.
function toPublicItemDto(item) {
  return {
    productId: item.productId,
    productName: item.productName,
    quantity: item.quantity,
    modelName: item.modelName,
    variantSelections: (item.variantSelections || []).map(v => ({
      variantTypeName: v.variantTypeName,
      optionName: v.optionName,
      priceDeltaCents: v.priceDeltaCents
    })),
    extras: item.extras,
    unitPriceCents: item.unitPriceCents
  };
}

function toPublicPrepareDto({ draftId, reused, clientSecret, paymentIntentId, paymentIntentStatus, snapshot }) {
  return {
    ok: true,
    draftId,
    reused,
    clientSecret,
    paymentIntentId,
    paymentIntentStatus,
    currency: snapshot.currency,
    totals: snapshot.totals,
    items: snapshot.items.map(toPublicItemDto)
  };
}

// --- Adapter de email real (sección 6) -----------------------------------------
// finalizePaidCheckout() nunca ve cart/pendingOrder/localStorage: solo recibe
// {orderId, snapshot, paymentIntent} después del commit. Este adapter traduce
// ESE snapshot al shape que ya espera sendConfirmationEmails (sin rediseñar
// templates ni tocar su HTML).
function snapshotItemToEmailCartItem(item) {
  return {
    name: item.productName,
    modelName: item.modelName,
    notes: item.notes,
    images: item.images,
    quantity: item.quantity,
    // Solo para DISPLAY en email (nunca se persiste ni se usa como
    // autoridad económica): conversión simple cents/100 es aceptable aquí.
    price: item.unitPriceCents / 100
  };
}

function makeSendConfirmationEmailAdapter(sendConfirmationEmailsFn) {
  return async function sendConfirmationEmailAdapter({ orderId, snapshot, paymentIntent }) {
    const cartLikeItems = snapshot.items.map(snapshotItemToEmailCartItem);
    const totalDecimal = snapshot.totals.totalCents / 100;
    await sendConfirmationEmailsFn(orderId, snapshot.customerData, cartLikeItems, totalDecimal, snapshot.currency);
  };
}

// --- Router ---------------------------------------------------------------------

// Construye los handlers Express como funciones nombradas independientes del
// router, para poder probarlos directamente en tests con req/res falsos, sin
// depender de las internals de express.Router ni de un servidor HTTP real.
function buildHandlers({
  checkoutPayment = defaultCheckoutPayment,
  checkoutFinalization = defaultCheckoutFinalization,
  stripe = defaultStripe,
  sendConfirmationEmailsFn = sendConfirmationEmails
} = {}) {
  const sendConfirmationEmailAdapter = makeSendConfirmationEmailAdapter(sendConfirmationEmailsFn);

  function stripeConfigHandler(req, res) {
    return res.json({ ok: true, publicKey: process.env.STRIPE_PUBLIC_KEY || '' });
  }

  // GET /api/pricing-config - Configuración pública de pricing (moneda + precios de extras).
  // Fuente única: config/pricing.js. Informativo para el frontend (previews);
  // la autoridad real sigue siendo services/pricing.js vía /create-payment-intent.
  function pricingConfigHandler(req, res) {
    const toDisplay = (cents) => ({ cents, amount: cents / 100 });
    return res.json({
      ok: true,
      currency: pricingConfig.currency,
      extras: {
        upscale: toDisplay(pricingConfig.extras.upscale),
        qr: toDisplay(pricingConfig.extras.qr),
        adapter: toDisplay(pricingConfig.extras.adapter)
      }
    });
  }

  // POST /api/create-payment-intent
  // Body allowlist ESTRICTO: { idempotencyKey, accessToken, selections }.
  // Ningún otro campo (price/total/currency/...) es válido; se rechaza con 400.
  async function createPaymentIntentHandler(req, res) {
    try {
      assertStrictAllowlist(req.body, ['idempotencyKey', 'accessToken', 'selections'], 'body');
      const { idempotencyKey, accessToken, selections } = req.body;

      const result = await checkoutPayment.prepareCanonicalCheckout(
        { idempotencyKey, accessToken, selections },
        { stripe }
      );

      return res.json(toPublicPrepareDto(result));
    } catch (err) {
      return sendDomainError(res, err, 'POST /create-payment-intent');
    }
  }

  // PATCH /api/checkout-draft/customer-data
  // accessToken SIEMPRE en el body (nunca en URL/query string). Aplica todas
  // las protecciones B4A: capability token, guard atómico de estado,
  // converted/expired rechazado, PI succeeded observado -> rechazo.
  async function updateCustomerDataHandler(req, res) {
    try {
      assertStrictAllowlist(req.body, ['accessToken', 'customerData'], 'body');
      const { accessToken, customerData } = req.body;
      if (typeof accessToken !== 'string' || accessToken.length === 0) {
        throw new RequestValidationError('accessToken debe ser un string no vacío');
      }

      await checkoutPayment.updateCheckoutCustomerData({ accessToken, customerData }, { stripe });

      return res.json({ ok: true });
    } catch (err) {
      return sendDomainError(res, err, 'PATCH /checkout-draft/customer-data');
    }
  }

  // POST /api/confirm-payment
  // Body allowlist ESTRICTO: SOLO { paymentIntentId }. cart/customerData/
  // totals/currency enviados por el cliente ya no se aceptan en absoluto --
  // toda la autoridad económica viene del draft asociado al PaymentIntent.
  async function confirmPaymentHandler(req, res) {
    try {
      assertStrictAllowlist(req.body, ['paymentIntentId'], 'body');
      const { paymentIntentId } = req.body;
      if (typeof paymentIntentId !== 'string' || !/^pi_[a-zA-Z0-9_]+$/.test(paymentIntentId)) {
        throw new RequestValidationError('paymentIntentId inválido');
      }

      if (!stripe) {
        throw Object.assign(new Error('Stripe no configurado'), { name: 'CheckoutPaymentError' });
      }
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

      const result = await checkoutFinalization.finalizePaidCheckout(paymentIntent, {
        sendConfirmationEmail: sendConfirmationEmailAdapter
      });

      return res.json({ ok: true, orderId: result.orderId, created: result.created });
    } catch (err) {
      return sendDomainError(res, err, 'POST /confirm-payment');
    }
  }

  return {
    stripeConfigHandler,
    pricingConfigHandler,
    createPaymentIntentHandler,
    updateCustomerDataHandler,
    confirmPaymentHandler
  };
}

function createPaymentsRouter(deps = {}) {
  const router = express.Router();
  const handlers = buildHandlers(deps);

  router.get('/stripe-config', handlers.stripeConfigHandler);
  router.get('/pricing-config', handlers.pricingConfigHandler);
  router.post('/create-payment-intent', handlers.createPaymentIntentHandler);
  router.patch('/checkout-draft/customer-data', handlers.updateCustomerDataHandler);
  router.post('/confirm-payment', handlers.confirmPaymentHandler);

  return router;
}

// --- Email real (sin cambios de diseño respecto al sistema legacy) ------------

async function sendConfirmationEmails(orderId, customerData, cart, total, selectedCurrency) {
  try {
    const baseUrl = process.env.PUBLIC_BASE_URL || process.env.BASE_URL || 'https://litum3d.com';
    const logoUrl = process.env.LOGO_URL
      ? process.env.LOGO_URL
      : `${baseUrl.replace(/\/$/, '')}/img/logos/lineal.logo.png`;
    const symbol = selectedCurrency === 'eur' ? '€' : selectedCurrency.toUpperCase();
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
      from: process.env.SMTP_USER || 'noreply@example.com',
      to: process.env.ADMIN_EMAIL || 'admin@example.com',
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

const router = createPaymentsRouter();
module.exports = router;
module.exports.createPaymentsRouter = createPaymentsRouter;
module.exports.buildHandlers = buildHandlers;
module.exports.mapDomainErrorToHttp = mapDomainErrorToHttp;
module.exports.assertStrictAllowlist = assertStrictAllowlist;
module.exports.RequestValidationError = RequestValidationError;
module.exports.toPublicPrepareDto = toPublicPrepareDto;
module.exports.toPublicItemDto = toPublicItemDto;
module.exports.snapshotItemToEmailCartItem = snapshotItemToEmailCartItem;
