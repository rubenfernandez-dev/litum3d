/*
  LITUM3D - Finalización idempotente de checkout pagado (P0E-B4A, conectada
  al checkout público en P0E-B4B).

  routes/payments.js#POST /api/confirm-payment llama a finalizePaidCheckout()
  tras retrieve() del PaymentIntent en Stripe. Un futuro webhook (fuera de
  alcance de B4B) reutilizará la misma función sin duplicar esta lógica.

  finalizePaidCheckout(paymentIntent) construye el pedido EXCLUSIVAMENTE
  desde el snapshot ya persistido en el checkout_draft asociado: nunca
  vuelve a consultar precios del catálogo ni recalcula nada económico. El
  pedido debe reflejar exactamente lo que Stripe cobró en su momento.

  La función legacy createOrderFromCart() (routes/payments.js, basada en
  item.price del cliente) se eliminó en P0E-B4B: finalizePaidCheckout() es
  ahora la ÚNICA vía de creación de pedidos pagados en el checkout público.
*/

const { pool: defaultPool } = require('../config/db');
const pricingConfig = require('../config/pricing');
const checkoutDrafts = require('./checkout-drafts');
const { DRAFT_STATUS } = checkoutDrafts;
const { validatePaymentIntentForDraft, PaymentIntentValidationError } = require('./checkout-payment');

// Server-controlled temporary checkout country.
// Revisit with international shipping/tax implementation.
const CHECKOUT_COUNTRY_CODE = 'CH';

// estado 1 = Pendiente / "Pedido recibido, pendiente de confirmación"
// (ver estado_pedido seed). TODO(B-futuro): revisar si un pedido creado con
// el pago ya succeeded debería nacer en otro estado; P0E-B4A NO cambia esto
// (fuera de alcance, ver ticket P0C).
const INITIAL_ORDER_ESTADO_ID = 1;

// --- Errores de dominio ----------------------------------------------------

class CentsRangeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CentsRangeError';
    Object.assign(this, details);
  }
}

class FinalizationIntegrityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'FinalizationIntegrityError';
    Object.assign(this, details);
  }
}

// --- Conversión cents/minor units -> DECIMAL(10,2) ----------------------------

// Límite real confirmado contra MySQL 8 en P0E-B4-PREFLIGHT: DECIMAL(10,2)
// admite como máximo 99999999.99, es decir 9999999999 cents.
const DECIMAL_10_2_MAX_CENTS = 9999999999;

/**
 * Valida que un importe en cents cabe en DECIMAL(10,2) ANTES de intentar
 * el INSERT. No depende del ERROR 1264 de MySQL como primera línea de
 * defensa (aunque MySQL lo rechazaría igualmente en modo estricto).
 */
function assertFitsDecimal10_2(cents, context = 'importe') {
  if (!Number.isSafeInteger(cents)) {
    throw new CentsRangeError(`${context}: cents debe ser un entero seguro (${cents})`, { context, cents });
  }
  if (cents < 0) {
    throw new CentsRangeError(`${context}: cents no puede ser negativo (${cents})`, { context, cents });
  }
  if (cents > DECIMAL_10_2_MAX_CENTS) {
    throw new CentsRangeError(
      `${context}: ${cents} cents excede el máximo de DECIMAL(10,2) (${DECIMAL_10_2_MAX_CENTS})`,
      { context, cents }
    );
  }
  return cents;
}

/**
 * Convierte cents (entero) a un string decimal apto para un INSERT/UPDATE
 * sobre una columna DECIMAL(10,2). Aritmética puramente entera + padding de
 * string: nunca usa (cents/100).toFixed(2), que pasaría por división en
 * coma flotante. (El nombre de la función se mantiene sin cambios: es
 * genérico y ya no menciona "rappen".)
 */
function centsToDecimalString(cents) {
  if (!Number.isSafeInteger(cents)) {
    throw new CentsRangeError(`cents debe ser un entero seguro: ${cents}`, { cents });
  }
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return (negative ? '-' : '') + String(whole) + '.' + frac;
}

// --- Utilidades internas -----------------------------------------------------

function extractDraftIdFromMetadata(paymentIntent) {
  const raw = paymentIntent?.metadata?.checkoutDraftId;
  const id = Number(raw);
  if (!raw || !Number.isInteger(id) || id <= 0) {
    throw new PaymentIntentValidationError(
      `paymentIntent.metadata.checkoutDraftId ausente o inválido: "${raw}"`,
      { reason: 'metadata_mismatch', paymentIntentId: paymentIntent?.id }
    );
  }
  return id;
}

function parseSnapshotJson(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') return JSON.parse(value);
  throw new FinalizationIntegrityError('snapshot_json corrupto o no reconocido al leer el draft bloqueado');
}

// variantes_seleccionadas: formato legacy detectado en producción era
// {baseId, shapeId} (routes/payments.js#createOrderFromCart, eliminada en
// P0E-B4B). El único consumidor real localizado es
// routes/pedidos.js, que hace JSON.parse(...) y lo reenvía sin asumir
// ninguna forma concreta (no desestructura baseId/shapeId); no hay ninguna
// vista/frontend admin que lea `.baseId`/`.shapeId` de ese JSON. Por eso
// aquí se escribe el formato canónico versionado sin necesidad de
// compatibilidad adicional (ver informe P0E-B4A, sección 11).
function buildVariantesSeleccionadasJson(variantSelections) {
  if (!Array.isArray(variantSelections) || variantSelections.length === 0) return null;
  return JSON.stringify({ schemaVersion: 1, variantSelections });
}

function extractImageRuta(img) {
  if (typeof img === 'string') return img;
  if (img && typeof img === 'object' && typeof img.url === 'string') return img.url;
  return null;
}

// --- Validación previa (fuera de transacción) ---------------------------------

async function loadAndValidateDraftForFinalization(paymentIntent, options) {
  const draftId = extractDraftIdFromMetadata(paymentIntent);

  // options.draftsDataAccess (no options.dataAccess): igual que en
  // checkout-payment.js, para no colisionar con options.pool, que aquí se
  // usa además directamente para la conexión transaccional propia de
  // finalizePaidCheckout (pool.getConnection()).
  const draft = await checkoutDrafts.getDraftById(draftId, { dataAccess: options.draftsDataAccess, pool: options.pool });
  if (!draft) {
    throw new checkoutDrafts.DraftNotFoundError(`Draft ${draftId} no encontrado`, { draftId });
  }

  // 5. valida amount/currency/status/id/metadata contra el snapshot
  // persistido. Comparte la MISMA función que usa checkout-payment.js al
  // recuperar un PI existente, para no duplicar esta comprobación.
  validatePaymentIntentForDraft(paymentIntent, draft, { requireSucceeded: true });

  return draft;
}

// --- Finalización transaccional -----------------------------------------------

/**
 * Crea el pedido correspondiente a un PaymentIntent ya succeeded,
 * EXCLUSIVAMENTE a partir del snapshot persistido en su checkout_draft.
 * Idempotente: si el pedido ya existe para este PaymentIntent (retry,
 * futuro webhook duplicado, carrera con otra finalización), lo recupera y
 * devuelve created:false en vez de crear otro o fallar.
 *
 * @param {object} paymentIntent - objeto PaymentIntent de Stripe (o
 *   equivalente inyectado en tests) ya recuperado con status validado por
 *   el caller (o se valida aquí igualmente antes de tocar BD).
 * @param {object} [options]
 * @param {object} [options.pool] - pool mysql2 alternativo (por defecto, config/db)
 * @param {Function} [options.sendConfirmationEmail] - async ({orderId, snapshot, paymentIntent}) => void.
 *   Si se omite, no se envía ningún email (B4A no conecta el sistema real
 *   de emails; eso es explícitamente un paso de B4B). Solo se invoca
 *   cuando created===true y después de un commit exitoso.
 * @returns {Promise<{orderId: number, created: boolean, draftId: number}>}
 */
async function finalizePaidCheckout(paymentIntent, options = {}) {
  const pool = options.pool || defaultPool;
  const sendConfirmationEmail = options.sendConfirmationEmail;

  const draft = await loadAndValidateDraftForFinalization(paymentIntent, options);
  const snapshot = draft.snapshot;

  const totalDecimal = centsToDecimalString(assertFitsDecimal10_2(snapshot.totals.totalCents, 'snapshot.totals.totalCents'));

  const conn = await pool.getConnection();
  let created = false;
  let orderId = null;
  try {
    await conn.beginTransaction();

    // Lock del draft dentro de la transacción (sección 19): serializa
    // finalizaciones concurrentes del MISMO draft/PI. Tras el lock se
    // revalida el estado relevante en vez de confiar solo en la lectura
    // anterior a abrir la transacción. Se incluye stripe_payment_intent_id
    // en el SELECT (no solo status/snapshot_json) para poder revalidar
    // contra el valor REAL bajo lock, no el leído antes de la transacción.
    const [lockedRows] = await conn.query(
      'SELECT id, status, snapshot_json, stripe_payment_intent_id FROM checkout_drafts WHERE id = ? FOR UPDATE',
      [draft.id]
    );
    const lockedDraftRow = lockedRows[0];
    if (!lockedDraftRow) {
      throw new checkoutDrafts.DraftNotFoundError(`Draft ${draft.id} no encontrado (bajo lock)`, { draftId: draft.id });
    }

    if (lockedDraftRow.status === DRAFT_STATUS.CONVERTED) {
      // Fast path idempotente: otra finalización ya completó este draft
      // mientras esperábamos el lock. No se escribe nada; se recupera el
      // pedido ya creado por PaymentIntent.
      const [existingOrders] = await conn.query(
        'SELECT id FROM pedidos WHERE stripe_payment_intent_id = ? LIMIT 1',
        [paymentIntent.id]
      );
      await conn.rollback();
      if (existingOrders.length) {
        return { orderId: existingOrders[0].id, created: false, draftId: draft.id };
      }
      // converted sin pedido asociado es un estado de corrupción/inconsistencia
      // real: nunca se debe reportar como éxito idempotente con orderId vacío.
      throw new FinalizationIntegrityError(
        `Draft ${draft.id} ya está converted pero no existe ningún pedido con stripe_payment_intent_id="${paymentIntent.id}"`,
        { draftId: draft.id, paymentIntentId: paymentIntent.id }
      );
    }

    const lockedSnapshot = parseSnapshotJson(lockedDraftRow.snapshot_json);

    // Revalidación bajo lock (sección 7 del hardening): la validación hecha
    // ANTES de abrir la transacción (loadAndValidateDraftForFinalization)
    // es solo un fast-fail barato. La que realmente autoriza el INSERT es
    // esta, contra el draft recién leído CON el lock — evita basar las
    // invariantes críticas (id/metadata/amount/currency del PI) en una
    // lectura que pudo quedar obsoleta entre el primer SELECT y este punto.
    validatePaymentIntentForDraft(
      paymentIntent,
      { id: lockedDraftRow.id, stripePaymentIntentId: lockedDraftRow.stripe_payment_intent_id, snapshot: lockedSnapshot },
      { requireSucceeded: true }
    );

    // EUR-ONLY-01: validatePaymentIntentForDraft ya garantiza que
    // paymentIntent.currency === snapshot.currency, pero no que esa moneda
    // sea la ACTIVA hoy -- un draft muy antiguo (creado bajo una config de
    // moneda previa, p.ej. antes del cutover EUR-only) podría en teoría
    // seguir siendo consistente internamente sin ser la moneda canónica
    // vigente. Se rechaza explícitamente en vez de persistir un pedido con
    // una moneda distinta de la que config/pricing.js declara hoy.
    if (lockedSnapshot.currency !== pricingConfig.currency) {
      await conn.rollback();
      throw new FinalizationIntegrityError(
        `snapshot.currency ("${lockedSnapshot.currency}") no coincide con la moneda canónica activa ("${pricingConfig.currency}")`,
        { draftId: draft.id, paymentIntentId: paymentIntent.id }
      );
    }

    // 20. Idempotencia definitiva: se intenta el INSERT directamente; la
    // garantía real es pedidos.stripe_payment_intent_id UNIQUE, no el
    // SELECT del "fast path" de arriba (que solo cubre el caso donde ya se
    // pudo tomar el lock después de un commit ajeno).
    try {
      const [orderResult] = await conn.query(
        `INSERT INTO pedidos
           (usuario_id, estado_id, total, customer_name, customer_email, customer_phone,
            customer_address, customer_city, customer_zip, customer_country, notas, stripe_payment_intent_id, currency)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          null,
          INITIAL_ORDER_ESTADO_ID,
          totalDecimal,
          lockedSnapshot.customerData?.name || null,
          lockedSnapshot.customerData?.email || null,
          lockedSnapshot.customerData?.phone || null,
          lockedSnapshot.customerData?.address || null,
          lockedSnapshot.customerData?.city || null,
          lockedSnapshot.customerData?.zip || null,
          CHECKOUT_COUNTRY_CODE,
          `Checkout draft #${draft.id}`,
          paymentIntent.id,
          // ISO 4217 en mayúsculas para persistencia (Stripe/config exigen
          // minúscula; aquí se deriva, nunca se hardcodea una segunda vez).
          lockedSnapshot.currency.toUpperCase()
        ]
      );
      orderId = orderResult.insertId;
      created = true;
    } catch (err) {
      if (isDuplicatePaymentIntentEntry(err)) {
        // Carrera real: otra transacción ganó el INSERT entre nuestro lock
        // del draft y este punto (p.ej. dos drafts distintos apuntando,
        // por un bug ajeno, al mismo PI -- attachPaymentIntent ya debería
        // impedirlo, pero esta es la defensa definitiva, no solo el SELECT).
        await conn.rollback();
        const [existingOrders] = await pool.query(
          'SELECT id FROM pedidos WHERE stripe_payment_intent_id = ? LIMIT 1',
          [paymentIntent.id]
        );
        if (existingOrders.length) {
          return { orderId: existingOrders[0].id, created: false, draftId: draft.id };
        }
        throw err; // estado inesperado: no ocultar el error original
      }
      throw err;
    }

    for (const item of lockedSnapshot.items) {
      const unitPriceDecimal = centsToDecimalString(
        assertFitsDecimal10_2(item.unitPriceCents, `detalle_pedidos.precio_unitario (producto ${item.productId})`)
      );
      const variantesJson = buildVariantesSeleccionadasJson(item.variantSelections);

      const [detailResult] = await conn.query(
        `INSERT INTO detalle_pedidos
           (pedido_id, producto_id, modelo_id, cantidad, precio_unitario, personalizacion_notas, variantes_seleccionadas)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [orderId, item.productId, item.modelId, item.quantity, unitPriceDecimal, item.notes || null, variantesJson]
      );
      const detalleId = detailResult.insertId;

      for (const rawImg of (item.images || []).slice(0, 3)) {
        const ruta = extractImageRuta(rawImg);
        if (!ruta) continue;
        if (ruta.length > 255) {
          throw new FinalizationIntegrityError(
            `La ruta de imagen del producto ${item.productId} supera los 255 caracteres que admite detalle_pedido_imagenes.ruta`,
            { draftId: draft.id, productId: item.productId, rutaLength: ruta.length }
          );
        }
        await conn.query(
          'INSERT INTO detalle_pedido_imagenes (detalle_pedido_id, ruta) VALUES (?, ?)',
          [detalleId, ruta]
        );
      }
    }

    await conn.query(
      'UPDATE checkout_drafts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [DRAFT_STATUS.CONVERTED, draft.id]
    );

    await conn.commit();
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* ignorar error de rollback */ }
    throw err;
  } finally {
    conn.release();
  }

  // Emails SOLO después de commit exitoso y SOLO si este proceso fue quien
  // realmente creó el pedido (nunca en un retry/duplicado).
  if (created && typeof sendConfirmationEmail === 'function') {
    try {
      await sendConfirmationEmail({ orderId, snapshot, paymentIntent });
    } catch (emailErr) {
      // Un fallo de email nunca deshace un pedido ya confirmado y pagado.
      console.error(`[checkout-finalization] Error enviando email de confirmación para pedido #${orderId}:`, emailErr.message);
    }
  }

  return { orderId, created, draftId: draft.id };
}

function isDuplicatePaymentIntentEntry(err) {
  if (!err || err.code !== 'ER_DUP_ENTRY') return false;
  const message = err.sqlMessage || err.message || '';
  return message.includes('stripe_payment_intent_id');
}

module.exports = {
  CentsRangeError,
  FinalizationIntegrityError,
  CHECKOUT_COUNTRY_CODE,
  assertFitsDecimal10_2,
  centsToDecimalString,
  finalizePaidCheckout
};
