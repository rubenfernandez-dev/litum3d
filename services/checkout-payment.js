/*
  LITUM3D - Orquestación de checkout canónico + Stripe (P0E-B4A, conectada al
  checkout público en P0E-B4B).

  routes/payments.js (POST /api/create-payment-intent, PATCH
  /api/checkout-draft/customer-data) y public/js/checkout.js son ahora los
  consumidores reales de este módulo. El flujo legacy (/api/pay,
  calculateCartTotals, createOrderFromCart) se eliminó en el cutover.

  Responsabilidades:
    - construir el snapshot canónico histórico a partir de selecciones,
      usando services/pricing.js#priceCartFromSelections como ÚNICA
      autoridad económica (este módulo nunca calcula ni corrige dinero);
    - orquestar creación/reutilización de checkout_draft (services/checkout-drafts.js)
      y de PaymentIntent de Stripe, con idempotencia estable en ambos niveles;
    - validar la relación PaymentIntent <-> draft antes de confiar en él.

  Este módulo NO abre transacciones MySQL ni crea pedidos: eso vive en
  services/checkout-finalization.js, que reutiliza validatePaymentIntentForDraft
  de aquí para no duplicar esa comprobación.
*/

const Stripe = require('stripe');
const { priceCartFromSelections } = require('./pricing');
const checkoutDrafts = require('./checkout-drafts');
const uploadsStorage = require('./uploads-storage');

const defaultStripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// --- Errores de dominio ----------------------------------------------------

class CheckoutPaymentError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CheckoutPaymentError';
    Object.assign(this, details);
  }
}

// Cubre todos los casos de "el PaymentIntent no es de fiar para este draft":
// status incorrecto, ID/metadata/amount/currency que no coinciden. El campo
// `reason` permite a un futuro route handler mapear a una respuesta HTTP
// concreta sin parsear el mensaje.
class PaymentIntentValidationError extends Error {
  constructor(message, { reason, draftId = null, paymentIntentId = null } = {}) {
    super(message);
    this.name = 'PaymentIntentValidationError';
    this.reason = reason;
    this.draftId = draftId;
    this.paymentIntentId = paymentIntentId;
  }
}

// Referencia de imagen inválida/falsificada en selections[].images[] (P0-FOTOS-01
// hardening): token incorrecto/ausente, URL externa, internal key o path
// legacy autoasignados por el cliente, filename con forma de traversal, o
// (solo en creación de draft nuevo) archivo que no existe realmente.
// SIEMPRE se lanza ANTES de tocar pricing/draft/Stripe -- nunca después de
// que Stripe ya haya cobrado.
class ImageReferenceValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ImageReferenceValidationError';
    Object.assign(this, details);
  }
}

// --- Snapshot canónico -------------------------------------------------------

// customerData es opcional en la creación del draft: P0E-A3 diseñó el draft
// para poder crearse cuando el checkout carga, antes de que el cliente haya
// rellenado el formulario. Por eso aquí NO se usa checkout-drafts#validateCustomerData
// (que exige todos los campos no vacíos: esa es la validación del endpoint de
// actualización explícita, sección 14) — solo se filtra a las claves
// permitidas y se completan con '' las ausentes, igual que el snapshot vacío
// de ejemplo ya documentado en checkout-drafts.js.
const CUSTOMER_DATA_FIELDS = ['name', 'email', 'phone', 'address', 'city', 'zip'];

function normalizeInitialCustomerData(raw) {
  const empty = { name: '', email: '', phone: '', address: '', city: '', zip: '' };
  if (raw === undefined || raw === null) return empty;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CheckoutPaymentError('customerData debe ser un objeto', { field: 'customerData' });
  }
  for (const key of Object.keys(raw)) {
    if (!CUSTOMER_DATA_FIELDS.includes(key)) {
      throw new CheckoutPaymentError(`Campo no permitido en customerData: "${key}"`, { field: key });
    }
  }
  const normalized = { ...empty };
  for (const field of CUSTOMER_DATA_FIELDS) {
    if (typeof raw[field] === 'string') normalized[field] = raw[field];
    else if (raw[field] !== undefined && raw[field] !== null) {
      throw new CheckoutPaymentError(`customerData.${field} debe ser string`, { field });
    }
  }
  return normalized;
}

/**
 * Construye el snapshot canónico completo a partir de selecciones no
 * confiables. La parte económica (`items`, `totals`, `currency`,
 * `schemaVersion`) es EXACTAMENTE el resultado de priceCartFromSelections,
 * sin renombrar ni recalcular ningún campo — evita que este módulo y el
 * motor de pricing puedan divergir silenciosamente.
 *
 * @param {Array<object>} selections - selecciones canónicas (ver services/pricing.js)
 * @param {object|null} [customerData] - datos de cliente ya conocidos (pueden faltar)
 * @param {object} [options]
 * @param {object} [options.pricingDataAccess] - dataAccess inyectable para priceCartFromSelections (tests)
 * @param {object} [options.pool] - pool mysql2 compartido (por defecto, config/db)
 */
async function buildCanonicalCheckoutSnapshot(selections, customerData = null, options = {}) {
  // options.pricingDataAccess (no options.dataAccess): priceCartFromSelections
  // y checkout-drafts.js esperan formas de dataAccess incompatibles entre sí
  // (getProduct/getModel/... vs insertDraft/findById/...); prepareCanonicalCheckout
  // necesita poder inyectar ambos simultáneamente en tests, así que cada uno
  // usa su propia clave en vez de compartir "dataAccess".
  const pricing = await priceCartFromSelections(selections, { dataAccess: options.pricingDataAccess, pool: options.pool });
  return {
    schemaVersion: pricing.schemaVersion,
    currency: pricing.currency,
    customerData: normalizeInitialCustomerData(customerData),
    items: pricing.items,
    totals: pricing.totals
  };
}

// --- Stripe idempotency key server-side --------------------------------------

// Determinista y estable por draft: la MISMA key en cualquier reintento del
// mismo draft, distinta para drafts distintos. Nunca se deriva de un valor
// controlado por el cliente (evita colisiones/abuso de idempotencia económica).
// Sufijo "_v1" para poder versionar el esquema de creación del PI sin
// colisionar con keys ya usadas si algún día cambia la lógica.
function buildStripeIdempotencyKey(draftId) {
  return `checkout_draft_${draftId}_payment_intent_v1`;
}

// --- Validación PaymentIntent <-> draft ---------------------------------------

/**
 * Verifica que un PaymentIntent (ya creado o recuperado de Stripe) es
 * realmente el que corresponde a este draft y a su snapshot persistido.
 * Con requireSucceeded=false se usa como comprobación de integridad al
 * recuperar un PI ya asociado (puede seguir pendiente); con
 * requireSucceeded=true (por defecto) es la comprobación estricta previa a
 * crear un pedido (services/checkout-finalization.js).
 *
 * NO corrige nada automáticamente: cualquier discrepancia es un error.
 */
function validatePaymentIntentForDraft(paymentIntent, draft, { requireSucceeded = true } = {}) {
  if (!paymentIntent || typeof paymentIntent !== 'object') {
    throw new PaymentIntentValidationError('paymentIntent inválido', { reason: 'invalid_payment_intent', draftId: draft?.id });
  }
  if (!draft || !draft.snapshot) {
    throw new PaymentIntentValidationError('draft o draft.snapshot inválido', { reason: 'invalid_draft', paymentIntentId: paymentIntent.id });
  }
  const snapshot = draft.snapshot;

  if (requireSucceeded && paymentIntent.status !== 'succeeded') {
    throw new PaymentIntentValidationError(
      `El PaymentIntent no está succeeded (status="${paymentIntent.status}")`,
      { reason: 'not_succeeded', draftId: draft.id, paymentIntentId: paymentIntent.id }
    );
  }
  if (paymentIntent.id !== draft.stripePaymentIntentId) {
    throw new PaymentIntentValidationError(
      `El PaymentIntent "${paymentIntent.id}" no coincide con el asociado al draft ("${draft.stripePaymentIntentId}")`,
      { reason: 'id_mismatch', draftId: draft.id, paymentIntentId: paymentIntent.id }
    );
  }
  const metaDraftId = paymentIntent.metadata?.checkoutDraftId;
  if (metaDraftId !== String(draft.id)) {
    throw new PaymentIntentValidationError(
      `metadata.checkoutDraftId ("${metaDraftId}") no coincide con el draft (${draft.id})`,
      { reason: 'metadata_mismatch', draftId: draft.id, paymentIntentId: paymentIntent.id }
    );
  }
  if (paymentIntent.amount !== snapshot.totals.totalCents) {
    throw new PaymentIntentValidationError(
      `amount del PaymentIntent (${paymentIntent.amount}) no coincide con snapshot.totals.totalCents (${snapshot.totals.totalCents})`,
      { reason: 'amount_mismatch', draftId: draft.id, paymentIntentId: paymentIntent.id }
    );
  }
  if (paymentIntent.currency !== snapshot.currency) {
    throw new PaymentIntentValidationError(
      `currency del PaymentIntent ("${paymentIntent.currency}") no coincide con snapshot.currency ("${snapshot.currency}")`,
      { reason: 'currency_mismatch', draftId: draft.id, paymentIntentId: paymentIntent.id }
    );
  }
  return true;
}

// --- Creación/recuperación de PaymentIntent -----------------------------------

async function ensurePaymentIntentForDraft(draft, stripe) {
  if (draft.stripePaymentIntentId) {
    // Draft reutilizado que ya tiene PI: NUNCA se crea otro. Se recupera y
    // se valida su integridad; si algo no cuadra, error explícito (sección 12).
    const paymentIntent = await stripe.paymentIntents.retrieve(draft.stripePaymentIntentId);
    validatePaymentIntentForDraft(paymentIntent, draft, { requireSucceeded: false });
    return { paymentIntent, created: false };
  }

  const idempotencyKey = buildStripeIdempotencyKey(draft.id);
  // Si esta llamada lanza (timeout/5xx/red) DESPUÉS de que Stripe ya haya
  // creado el PaymentIntent internamente, NO se captura el error aquí: se
  // propaga tal cual. El draft sigue sin stripe_payment_intent_id asociado
  // (attachPaymentIntent no llegó a ejecutarse), así que un reintento
  // completo de prepareCanonicalCheckout con la MISMA idempotencyKey +
  // accessToken + selecciones recupera el MISMO draft (createOrGetDraft) y
  // vuelve a llamar aquí con la MISMA Stripe idempotency key determinista
  // -> Stripe devuelve el mismo PaymentIntent en vez de crear uno nuevo.
  const paymentIntent = await stripe.paymentIntents.create(
    {
      amount: draft.snapshot.totals.totalCents,
      currency: draft.snapshot.currency,
      metadata: { checkoutDraftId: String(draft.id) }
    },
    { idempotencyKey }
  );
  return { paymentIntent, created: true };
}

// --- Canonicalización de imágenes ANTES de fingerprint/pricing/draft --------
// (P0-FOTOS-01, hardening post-review). Ver services/uploads-storage.js
// #resolveClientPreviewReference para el detalle de qué se rechaza.
//
// Se ejecuta SIEMPRE como primer paso de prepareCanonicalCheckout, antes de
// tocar fingerprint/catálogo/pricing/Stripe -- así:
//   1) el cliente NUNCA puede autoasignarse una internal key ("custom/x.jpg")
//      ni reenviar el path legacy ("/uploads/custom/x.jpg"): solo una
//      capability URL con token HMAC válido se acepta, y el servidor es
//      quien decide la key interna final, nunca el cliente;
//   2) el fingerprint (fast path Y creación) se calcula sobre la MISMA
//      representación canónica ("custom/<file>"), nunca sobre la capability
//      URL -- mismo archivo real siempre produce el mismo fingerprint,
//      independientemente de la URL con la que el cliente la referenciara;
//   3) checkout_drafts.snapshot_json nunca llega a contener un capability
//      token: la limpieza ya no depende de que finalizePaidCheckout la haga
//      "después" (services/checkout-finalization.js sigue teniendo esa
//      limpieza, pero ahora es puramente defensiva/legacy, ver ese archivo);
//   4) una referencia inválida/falsificada se rechaza con 400 ANTES de
//      pricing/draft/Stripe -- nunca después de que Stripe ya haya cobrado.
//
// verifyExistence=true SOLO para creación de draft NUEVO (toca filesystem,
// fs.realpath vía resolveCustomUploadPath): un draft nuevo no debe poder
// crearse -- y por tanto no debe poder generar un PaymentIntent cobrable --
// referenciando un archivo que no existe.
// verifyExistence=false para el fast path de retry de un draft YA existente
// (B4A): solo verificación de token, pura/determinista, SIN tocar el
// filesystem -- el archivo ya se verificó existente cuando el draft se creó
// la primera vez, y el fast path está explícitamente diseñado (P0E-B4A #1)
// para no depender de que nada externo (catálogo, ahora tampoco filesystem)
// siga en el mismo estado que en la creación original.
async function canonicalizeSelectionsImages(selections, { verifyExistence }) {
  if (!Array.isArray(selections)) return selections;
  const canonical = [];
  for (let itemIndex = 0; itemIndex < selections.length; itemIndex++) {
    const item = selections[itemIndex];
    if (!item || typeof item !== 'object' || !Array.isArray(item.images) || item.images.length === 0) {
      canonical.push(item);
      continue;
    }
    const canonicalImages = [];
    for (let imgIndex = 0; imgIndex < item.images.length; imgIndex++) {
      const rawImg = item.images[imgIndex];
      const rawUrl = typeof rawImg === 'string' ? rawImg : (rawImg && typeof rawImg === 'object' ? rawImg.url : undefined);
      const resolved = uploadsStorage.resolveClientPreviewReference(rawUrl);
      if (!resolved.ok) {
        throw new ImageReferenceValidationError(
          `selections[${itemIndex}].images[${imgIndex}] no es una referencia de imagen válida (${resolved.reason})`,
          { itemIndex, imgIndex, reason: resolved.reason }
        );
      }
      if (verifyExistence) {
        const exists = await uploadsStorage.verifyCustomUploadExists(resolved.filename);
        if (!exists) {
          throw new ImageReferenceValidationError(
            `selections[${itemIndex}].images[${imgIndex}] referencia un archivo que no existe`,
            { itemIndex, imgIndex, reason: 'missing_file' }
          );
        }
      }
      canonicalImages.push(typeof rawImg === 'string' ? resolved.canonical : { ...rawImg, url: resolved.canonical });
    }
    canonical.push({ ...item, images: canonicalImages });
  }
  return canonical;
}

// --- Preparar checkout completo ------------------------------------------------

/**
 * Orquesta un intento de checkout completo, sin tocar HTTP.
 *
 * Fast path (draft ya existente, identificado por idempotencyKey): NUNCA
 * consulta el catálogo/pricing. Un retry de un draft ya creado no puede
 * depender de que el producto/modelo/opción de variante originales sigan
 * existiendo o activos (hardening P0E-B4A #1) — el fingerprint se calcula
 * de forma puramente local (computeSelectionsFingerprint, sin BD) y se
 * compara contra el ya persistido; el access token se verifica contra ESE
 * draft; y se continúa directamente con SU snapshot histórico.
 *
 * Camino de primera creación (no existe draft con esa idempotencyKey):
 *   1. calcula pricing + snapshot candidato;
 *   2. createOrGetDraft() — sigue siendo la garantía definitiva de
 *      concurrencia: si otra request ganó la carrera por UNIQUE mientras
 *      calculábamos pricing aquí, se recupera SU draft/snapshot (el
 *      ganador), nunca el candidato calculado localmente;
 *   3. crea o recupera el PaymentIntent de Stripe para ese draft;
 *   4. asocia el PaymentIntent al draft (idempotente, reglas en checkout-drafts).
 *
 * @returns {Promise<{draftId, reused, clientSecret, paymentIntentId, paymentIntentStatus, snapshot}>}
 *   Respuesta INTERNA del servicio. No expone access_token_hash. El futuro
 *   endpoint HTTP decide qué subconjunto reenviar al navegador.
 */
async function prepareCanonicalCheckout({ idempotencyKey, accessToken, selections, customerData }, options = {}) {
  const stripe = options.stripe || defaultStripe;
  if (!stripe) {
    throw new CheckoutPaymentError('Stripe no está configurado (falta STRIPE_SECRET_KEY o options.stripe)');
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0 || idempotencyKey.length > 255) {
    throw new checkoutDrafts.DraftValidationError('idempotencyKey debe ser un string no vacío (máximo 255 caracteres)');
  }

  const draftsOptions = { dataAccess: options.draftsDataAccess, pool: options.pool };

  const existingDraft = await checkoutDrafts.getDraftByIdempotencyKey(idempotencyKey, draftsOptions);

  // P0-FOTOS-01 hardening: canonicaliza ANTES de fingerprint/pricing/draft/
  // Stripe (ver canonicalizeSelectionsImages arriba). A partir de aquí,
  // canonicalSelections es la ÚNICA representación de selections que se usa
  // -- nunca las selections crudas del cliente.
  const canonicalSelections = await canonicalizeSelectionsImages(selections, { verifyExistence: !existingDraft });

  let draft;
  let reused;

  if (existingDraft) {
    // Fast path: cero consultas al catálogo. Solo cómputo local + lectura
    // del propio draft.
    const selectionsFingerprint = checkoutDrafts.computeSelectionsFingerprint(canonicalSelections);
    if (existingDraft.selectionsFingerprint !== selectionsFingerprint) {
      throw new checkoutDrafts.DraftIdempotencyConflictError(
        `La idempotency_key "${idempotencyKey}" ya se usó con una selección distinta`,
        { idempotencyKey, existingDraftId: existingDraft.id }
      );
    }
    const tokenOk = await checkoutDrafts.verifyAccessToken(accessToken, existingDraft.id, draftsOptions);
    if (!tokenOk) {
      throw new checkoutDrafts.DraftAccessDeniedError(
        `La idempotency_key "${idempotencyKey}" ya se usó con un access token distinto`
      );
    }
    draft = existingDraft;
    reused = true;
  } else {
    // Primera creación (o carrera con otra request equivalente): aquí SÍ
    // se consulta el catálogo, porque no hay ningún snapshot histórico que
    // preservar todavía.
    const candidateSnapshot = await buildCanonicalCheckoutSnapshot(canonicalSelections, customerData, options);
    const created = await checkoutDrafts.createOrGetDraft(
      { idempotencyKey, accessToken, selections: canonicalSelections, snapshot: candidateSnapshot },
      draftsOptions
    );
    draft = created.draft;
    reused = created.reused;
  }

  // Snapshot inmutable económicamente: siempre el persistido en el draft
  // (propio o recuperado), nunca recalculado en el fast path.
  const snapshot = draft.snapshot;

  const { paymentIntent } = await ensurePaymentIntentForDraft({ ...draft, snapshot }, stripe);

  const finalDraft = await checkoutDrafts.attachPaymentIntent(draft.id, paymentIntent.id, draftsOptions);

  return {
    draftId: finalDraft.id,
    reused,
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id,
    paymentIntentStatus: paymentIntent.status,
    snapshot
  };
}

// --- CustomerData con protección Stripe ---------------------------------------

/**
 * Igual que checkout-drafts#updateCustomerDataByAccessToken, pero añade la
 * comprobación de que el PaymentIntent asociado (si existe) no esté ya
 * succeeded. Nunca toca items/totals/currency/selections fingerprint —
 * updateCustomerDataByAccessToken solo escribe snapshot.customerData.
 */
async function updateCheckoutCustomerData({ accessToken, customerData }, options = {}) {
  const stripe = options.stripe || defaultStripe;
  if (!stripe) {
    throw new CheckoutPaymentError('Stripe no está configurado (falta STRIPE_SECRET_KEY o options.stripe)');
  }

  const draftsOptions = { dataAccess: options.draftsDataAccess, pool: options.pool };
  const draft = await checkoutDrafts.getDraftByAccessToken(accessToken, draftsOptions);
  if (!draft) throw new checkoutDrafts.DraftAccessDeniedError('Access token no reconocido');

  if (draft.status === checkoutDrafts.DRAFT_STATUS.CONVERTED || draft.status === checkoutDrafts.DRAFT_STATUS.EXPIRED) {
    // updateCustomerDataByAccessToken ya rechaza estos estados; se delega
    // directamente para no duplicar esa comprobación ni gastar una llamada
    // a Stripe en un draft que ya sabemos cerrado.
    return checkoutDrafts.updateCustomerDataByAccessToken(accessToken, customerData, draftsOptions);
  }

  if (draft.stripePaymentIntentId) {
    const paymentIntent = await stripe.paymentIntents.retrieve(draft.stripePaymentIntentId);
    if (paymentIntent.status === 'succeeded') {
      throw new checkoutDrafts.DraftStateError(
        'No se puede modificar customerData: el pago de este draft ya se completó',
        { draftId: draft.id, currentStatus: draft.status }
      );
    }
  }

  return checkoutDrafts.updateCustomerDataByAccessToken(accessToken, customerData, draftsOptions);
}

module.exports = {
  CheckoutPaymentError,
  PaymentIntentValidationError,
  ImageReferenceValidationError,
  buildCanonicalCheckoutSnapshot,
  buildStripeIdempotencyKey,
  validatePaymentIntentForDraft,
  ensurePaymentIntentForDraft,
  canonicalizeSelectionsImages,
  prepareCanonicalCheckout,
  updateCheckoutCustomerData
};
