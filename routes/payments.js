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
const path = require('path');
const pricingConfig = require('../config/pricing');
const defaultCheckoutPayment = require('../services/checkout-payment');
const defaultCheckoutFinalization = require('../services/checkout-finalization');
const checkoutDrafts = require('../services/checkout-drafts');
const { PricingValidationError } = require('../services/pricing');
const uploadsStorage = require('../services/uploads-storage');
const { getTransporter, getFromAddress } = require('../services/mailer');
const { buildOrderConfirmationEmail, buildAdminNewOrderEmail } = require('../services/order-emails');
const { SUPPORT_INFO } = require('../services/email-template');

const defaultStripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// Transporter capturado UNA VEZ al cargar este módulo (igual que el código
// legacy que sustituye) -- scripts/check-admin-order-photos-retention.js
// depende de este orden exacto: instala un nodemailer falso, borra este
// módulo de require.cache y lo vuelve a requerir (capturando el fake AQUÍ,
// de forma síncrona), y solo entonces restaura el nodemailer real -- el
// envío real ocurre después, reusando este `transporter` ya creado. Llamar
// a getTransporter() de forma perezosa dentro de sendConfirmationEmails
// (en vez de aquí) haría que ese envío tardío viera el nodemailer YA
// restaurado, rompiendo ese test.
const transporter = getTransporter();

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
  // P0-FOTOS-01 hardening: referencia de imagen inválida/falsificada
  // (token incorrecto, URL externa, internal key autoasignada, archivo
  // inexistente...) detectada ANTES de tocar pricing/draft/Stripe -- 400,
  // igual que el resto de rechazos de selections malformadas.
  if (err && err.name === 'ImageReferenceValidationError') {
    return { status: 400, code: 'image_reference_invalid', message: 'Una de las imágenes de la selección no es válida' };
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
    // Saneamiento de emails: variantes ("Base: Madera") y extras
    // (upscale/qr/adapter) que la plantilla unificada (services/order-emails.js)
    // ya sabe mostrar -- campo aditivo, no rompe el contrato existente de
    // este adapter (name/modelName/notes/images/quantity/price).
    variantSelections: item.variantSelections,
    extras: item.extras,
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
    await sendConfirmationEmailsFn(orderId, snapshot.customerData, cartLikeItems, totalDecimal, snapshot.currency, snapshot.totals.shippingCents);
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

  // POST /api/stripe/webhook (P0E-B5)
  // Único consumidor de finalizePaidCheckout() que NO depende de que el
  // navegador vuelva a llamar a /api/confirm-payment: Stripe reconcilia
  // pedidos aunque el cliente cierre la pestaña, pierda conexión o nunca
  // vuelva del redirect 3DS. Reutiliza EXACTAMENTE la misma
  // checkoutFinalization.finalizePaidCheckout() + sendConfirmationEmailAdapter
  // que POST /confirm-payment -- toda la idempotencia (pedidos.stripe_payment_intent_id
  // UNIQUE + revalidación bajo lock) y toda la validación económica
  // (amount/currency/metadata/status contra el snapshot persistido) ya vive
  // ahí; este handler NO duplica ninguna de esas comprobaciones.
  //
  // Requiere req.body como Buffer RAW (ver createStripeWebhookRouter/server.js):
  // stripe.webhooks.constructEvent necesita el byte-a-byte exacto que Stripe
  // firmó, nunca un objeto ya parseado por express.json().
  async function stripeWebhookHandler(req, res) {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!stripe) {
      console.error('[routes/payments] POST /stripe/webhook: Stripe no configurado (falta STRIPE_SECRET_KEY)');
      return res.status(400).json({ received: false });
    }
    if (!webhookSecret) {
      // Fail-closed explícito (sección 3): sin secret no hay forma de
      // verificar la firma, así que nunca se procesa el evento como si
      // viniera de Stripe. No hay fallback inseguro.
      console.error('[routes/payments] POST /stripe/webhook: STRIPE_WEBHOOK_SECRET no configurado -- rechazando evento sin verificar');
      return res.status(400).json({ received: false });
    }
    const signature = req.headers['stripe-signature'];
    if (!signature) {
      return res.status(400).json({ received: false });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
    } catch (err) {
      // Firma ausente/inválida, payload manipulado o secret incorrecto:
      // nunca se procesa el evento. Nunca se expone el motivo detallado ni
      // la firma/secret en la respuesta.
      console.error('[routes/payments] POST /stripe/webhook: firma inválida -', err.message);
      return res.status(400).json({ received: false });
    }

    try {
      if (event.type === 'payment_intent.succeeded') {
        const paymentIntent = event.data.object;
        const checkoutDraftId = paymentIntent?.metadata?.checkoutDraftId;

        if (!checkoutDraftId) {
          // PI válidamente firmado pero ajeno al checkout canónico de
          // LITUM3D (sección 15): nunca se convierte en pedido. Se
          // reconoce con 200 para que Stripe no reintente indefinidamente
          // un evento que nunca podrá "resolverse" de otra forma.
          console.warn(`[routes/payments] webhook event.id=${event.id} type=${event.type} paymentIntentId=${paymentIntent?.id}: sin metadata.checkoutDraftId, PI ajeno -- ignorado`);
          return res.status(200).json({ received: true });
        }

        try {
          const result = await checkoutFinalization.finalizePaidCheckout(paymentIntent, {
            sendConfirmationEmail: sendConfirmationEmailAdapter
          });
          console.log(`[routes/payments] webhook event.id=${event.id} type=${event.type} paymentIntentId=${paymentIntent.id} checkoutDraftId=${checkoutDraftId} orderId=${result.orderId} created=${result.created}`);
          return res.status(200).json({ received: true });
        } catch (finalizeErr) {
          if (isDefinitiveIntegrityError(finalizeErr)) {
            // Anomalía permanente (amount/currency/metadata mismatch, draft
            // inexistente, overflow DECIMAL...): reintentar el MISMO evento
            // nunca la resolverá, así que se reconoce con 200 para detener
            // los reintentos de Stripe, pero se deja un log ERROR severo
            // para investigación manual (sección 12).
            console.error(`[routes/payments] webhook ANOMALÍA DE INTEGRIDAD DEFINITIVA event.id=${event.id} paymentIntentId=${paymentIntent.id} checkoutDraftId=${checkoutDraftId}: ${finalizeErr.name} - ${finalizeErr.message}`);
            return res.status(200).json({ received: true });
          }
          // Fallo transitorio (DB caída/timeout/error inesperado antes de
          // commit): 5xx para que Stripe reintente el evento más tarde.
          console.error(`[routes/payments] webhook fallo transitorio event.id=${event.id} paymentIntentId=${paymentIntent.id}: ${finalizeErr.name || 'Error'} - ${finalizeErr.message}`);
          return res.status(500).json({ received: false });
        }
      }

      if (event.type === 'payment_intent.payment_failed' || event.type === 'payment_intent.canceled') {
        // Nunca crea pedido, nunca marca converted, nunca envía email de
        // confirmación (sección 9). Solo contexto técnico mínimo en logs.
        const paymentIntent = event.data.object;
        console.log(`[routes/payments] webhook event.id=${event.id} type=${event.type} paymentIntentId=${paymentIntent?.id} checkoutDraftId=${paymentIntent?.metadata?.checkoutDraftId || 'n/a'}: sin acción (no crea pedido)`);
        return res.status(200).json({ received: true });
      }

      // Evento válidamente firmado pero no manejado (sección 10): 200 sin
      // hacer nada, para no provocar reintentos innecesarios de Stripe.
      return res.status(200).json({ received: true });
    } catch (err) {
      console.error(`[routes/payments] webhook error inesperado event.id=${event.id}: ${err.name || 'Error'} - ${err.message}`);
      return res.status(500).json({ received: false });
    }
  }

  return {
    stripeConfigHandler,
    pricingConfigHandler,
    createPaymentIntentHandler,
    updateCustomerDataHandler,
    confirmPaymentHandler,
    stripeWebhookHandler
  };
}

// Errores de integridad definitivos (sección 12): reintentar el MISMO
// evento de Stripe nunca los resolverá porque el estado esperado (importe,
// moneda, metadata, existencia del draft) es permanentemente incompatible.
// Duck-typing por err.name (no instanceof), igual que mapDomainErrorToHttp:
// checkoutFinalization/checkoutPayment pueden ser dobles inyectados en
// tests que no comparten la referencia de clase real.
function isDefinitiveIntegrityError(err) {
  const name = err && err.name;
  return name === 'PaymentIntentValidationError'
    || name === 'FinalizationIntegrityError'
    || name === 'CentsRangeError'
    || name === 'DraftNotFoundError';
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

// Router dedicado para el webhook de Stripe (P0E-B5). Se monta en server.js
// en una ruta EXACTA (/api/stripe/webhook) ANTES de express.json() global,
// con express.raw({type:'application/json'}) propio: así req.body llega
// como Buffer sin parsear (requisito de stripe.webhooks.constructEvent) sin
// afectar al resto de rutas de /api, que siguen usando JSON normal vía
// paymentsRoutes (montado después de express.json(), sin tocar ese orden).
function createStripeWebhookRouter(deps = {}) {
  const router = express.Router();
  const handlers = buildHandlers(deps);
  router.post('/', express.raw({ type: 'application/json' }), handlers.stripeWebhookHandler);
  return router;
}

// --- Email real (plantilla única, ver services/order-emails.js) ---------------
//
// Saneamiento del sistema de emails: el HTML/text de ambos correos (cliente
// y Admin) ya no se construye aquí -- vive en services/order-emails.js sobre
// la capa visual compartida services/email-template.js (mismo logo/colores
// reales de LITUM3D, mismo footer con enlaces legales, mismo bloque de
// soporte). Esta función solo adapta el shape legacy (cart/total en
// decimal) al que esperan esos builders y sigue siendo la única responsable
// de construir los attachments reales (fotos del pedido) -- eso NO cambia.

async function sendConfirmationEmails(orderId, customerData, cart, total, selectedCurrency, shippingCents = 0) {
  try {
    const orderDate = new Date();
    const items = cart.map(item => ({
      productName: item.name,
      modelName: item.modelName,
      variantSelections: item.variantSelections,
      extras: item.extras,
      notes: item.notes,
      quantity: item.quantity,
      unitPriceCents: Math.round(item.price * 100)
    }));
    const totals = { shippingCents, totalCents: Math.round(total * 100) };

    // P0-FOTOS-01: se resuelve el nombre físico con la MISMA validación
    // segura que el resto del sistema (uploadsStorage.resolveCustomUploadPath
    // -- basename + charset + contención de raíz + resolución de symlinks),
    // en vez de construir el path a mano desde un valor que en última
    // instancia viene del snapshot del cliente. img.filename (metadata,
    // nunca autoridad de filesystem) es la fuente preferida; si faltara, se
    // deriva del propio img.url/img (compatibilidad con snapshots ya
    // existentes).
    //
    // P1 Admin Pedidos/Fotos/Retención: este adjunto se lee y se envía AQUÍ,
    // en el momento del pago -- es una COPIA independiente que Nodemailer
    // entrega al buzón de ADMIN_EMAIL. Cuando más tarde
    // services/order-photo-retention.js borra el archivo físico en
    // uploads/custom/ (al marcar el pedido como "Entregado"), ese borrado
    // NUNCA puede alcanzar ni revertir un email que ya salió del servidor:
    // el adjunto sigue existiendo en el buzón del administrador (y en
    // cualquier backup/relay SMTP intermedio) exactamente igual que antes
    // del borrado. Ver scripts/check-admin-order-photos-retention.js para
    // la prueba de regresión que documenta esta independencia temporal.
    const attachments = [];
    for (const item of cart) {
      const images = Array.isArray(item.images) ? item.images : [];
      for (const img of images) {
        const candidate = (img && typeof img === 'object' && typeof img.filename === 'string')
          ? img.filename
          : (typeof img === 'string' ? img : (img && img.url) || '');
        if (!candidate) continue;
        const resolvedPath = await uploadsStorage.resolveCustomUploadPath(path.basename(String(candidate).split('?')[0]));
        if (resolvedPath) {
          attachments.push({
            filename: path.basename(resolvedPath),
            path: resolvedPath
          });
        }
      }
    }
    const hasPhotos = attachments.length > 0;

    const customerEmail = buildOrderConfirmationEmail({
      // El idioma real del comprador no se persiste hoy en ningún sitio
      // fiable (ver services/order-emails.js, cabecera, y el informe de
      // saneamiento de emails, sección "ES/DE/FR"): fallback explícito y
      // previsible a 'es', NUNCA inferido del país de envío.
      locale: 'es',
      orderId, orderDate, customerData, items, totals, currency: selectedCurrency
    });
    const adminEmail = buildAdminNewOrderEmail({
      orderId, orderDate, customerData, items, totals, currency: selectedCurrency, hasPhotos
    });

    // Reply-To (sección 10 del informe): el cliente responde -> llega a
    // soporte de LITUM3D. Admin responde -> llega directamente al cliente.
    await transporter.sendMail({
      from: getFromAddress(),
      to: customerData.email,
      replyTo: SUPPORT_INFO.email,
      subject: customerEmail.subject,
      html: customerEmail.html,
      text: customerEmail.text
    });

    await transporter.sendMail({
      from: getFromAddress(),
      to: process.env.ADMIN_EMAIL || 'admin@example.com',
      replyTo: customerData.email,
      subject: adminEmail.subject,
      html: adminEmail.html,
      text: adminEmail.text,
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

const router = createPaymentsRouter();
module.exports = router;
module.exports.createPaymentsRouter = createPaymentsRouter;
module.exports.createStripeWebhookRouter = createStripeWebhookRouter;
module.exports.isDefinitiveIntegrityError = isDefinitiveIntegrityError;
module.exports.buildHandlers = buildHandlers;
module.exports.mapDomainErrorToHttp = mapDomainErrorToHttp;
module.exports.assertStrictAllowlist = assertStrictAllowlist;
module.exports.RequestValidationError = RequestValidationError;
module.exports.toPublicPrepareDto = toPublicPrepareDto;
module.exports.toPublicItemDto = toPublicItemDto;
module.exports.snapshotItemToEmailCartItem = snapshotItemToEmailCartItem;
