/*
  LITUM3D - Infraestructura de checkout drafts (P0E-B3).

  Este módulo NO calcula dinero ni habla con Stripe. Persiste, recupera y
  gestiona el ciclo de vida de un "draft" de checkout a partir de:
    - un snapshot YA CONSTRUIDO por el llamante (futuro P0E-B4, que sí usará
      services/pricing.js#priceCartFromSelections antes de llegar aquí);
    - un idempotency_key proporcionado por el cliente;
    - un fingerprint de selecciones calculado siempre por el servidor.

  Conectado al checkout público desde P0E-B4B vía services/checkout-payment.js
  y services/checkout-finalization.js (routes/payments.js + public/js/checkout.js).
*/

const crypto = require('crypto');
const { pool: defaultPool } = require('../config/db');
const { ALLOWED_CHECKOUT_COUNTRIES, isAllowedCheckoutCountry } = require('../config/checkout-countries');

// --- Estados -------------------------------------------------------------

const DRAFT_STATUS = Object.freeze({
  CREATED: 'created',
  PAYMENT_PENDING: 'payment_pending',
  CONVERTED: 'converted',
  EXPIRED: 'expired'
});

// Máquina de estados mínima (única fuente de verdad de las transiciones
// permitidas, para no dispersar strings mágicos por el código). B3 no
// implementa cron ni expiración automática: estas transiciones solo se
// disparan cuando algo (futuro código) llama updateDraftStatus/attachPaymentIntent
// explícitamente.
const ALLOWED_TRANSITIONS = Object.freeze({
  [DRAFT_STATUS.CREATED]: new Set([DRAFT_STATUS.PAYMENT_PENDING, DRAFT_STATUS.EXPIRED]),
  [DRAFT_STATUS.PAYMENT_PENDING]: new Set([DRAFT_STATUS.CONVERTED, DRAFT_STATUS.EXPIRED]),
  [DRAFT_STATUS.CONVERTED]: new Set(),
  [DRAFT_STATUS.EXPIRED]: new Set()
});

// --- Errores de dominio ----------------------------------------------------

class DraftValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DraftValidationError';
    Object.assign(this, details);
  }
}

class DraftIdempotencyConflictError extends Error {
  constructor(message, { idempotencyKey, existingDraftId } = {}) {
    super(message);
    this.name = 'DraftIdempotencyConflictError';
    this.idempotencyKey = idempotencyKey;
    this.existingDraftId = existingDraftId;
  }
}

class DraftAccessDeniedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DraftAccessDeniedError';
  }
}

class DraftStateError extends Error {
  constructor(message, { draftId, currentStatus, attemptedStatus } = {}) {
    super(message);
    this.name = 'DraftStateError';
    this.draftId = draftId;
    this.currentStatus = currentStatus;
    this.attemptedStatus = attemptedStatus;
  }
}

class DraftPaymentIntentConflictError extends Error {
  constructor(message, { draftId, existingPaymentIntentId, attemptedPaymentIntentId } = {}) {
    super(message);
    this.name = 'DraftPaymentIntentConflictError';
    this.draftId = draftId;
    this.existingPaymentIntentId = existingPaymentIntentId;
    this.attemptedPaymentIntentId = attemptedPaymentIntentId;
  }
}

class DraftNotFoundError extends Error {
  constructor(message, { draftId } = {}) {
    super(message);
    this.name = 'DraftNotFoundError';
    this.draftId = draftId;
  }
}

// --- Acceso a datos (inyectable para tests, mismo patrón que services/pricing.js) ---

function defaultDataAccess(pool) {
  return {
    async insertDraft({ idempotencyKey, selectionsFingerprint, accessTokenHash, snapshotJson, status, expiresAt }) {
      const [result] = await pool.query(
        `INSERT INTO checkout_drafts
           (idempotency_key, selections_fingerprint, access_token_hash, snapshot_json, status, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [idempotencyKey, selectionsFingerprint, accessTokenHash, snapshotJson, status, expiresAt]
      );
      return result.insertId;
    },
    async findById(id) {
      const [rows] = await pool.query('SELECT * FROM checkout_drafts WHERE id = ? LIMIT 1', [id]);
      return rows[0] || null;
    },
    async findByIdempotencyKey(idempotencyKey) {
      const [rows] = await pool.query('SELECT * FROM checkout_drafts WHERE idempotency_key = ? LIMIT 1', [idempotencyKey]);
      return rows[0] || null;
    },
    async findByAccessTokenHash(accessTokenHash) {
      const [rows] = await pool.query('SELECT * FROM checkout_drafts WHERE access_token_hash = ? LIMIT 1', [accessTokenHash]);
      return rows[0] || null;
    },
    // La condición de estado forma parte de la propia escritura (no de un
    // SELECT previo): si otra transacción cambió el status entre nuestra
    // lectura y este UPDATE (p.ej. finalizePaidCheckout marcándolo
    // converted), affectedRows=0 y el caller debe releer para decidir el
    // error correcto, en vez de asumir que la condición leída antes sigue
    // siendo cierta en el momento real de la escritura.
    async updateSnapshotIfStatusIn(id, snapshotJson, allowedStatuses) {
      const [result] = await pool.query(
        'UPDATE checkout_drafts SET snapshot_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN (?)',
        [snapshotJson, id, allowedStatuses]
      );
      return result.affectedRows;
    },
    async updateStatus(id, status) {
      await pool.query(
        'UPDATE checkout_drafts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [status, id]
      );
    },
    async attachStripePaymentIntent(id, paymentIntentId, status) {
      await pool.query(
        'UPDATE checkout_drafts SET stripe_payment_intent_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [paymentIntentId, status, id]
      );
    }
  };
}

function resolveDataAccess(options) {
  return options.dataAccess || defaultDataAccess(options.pool || defaultPool);
}

// Detecta una violación de UNIQUE KEY del driver mysql2 real (err.code
// 'ER_DUP_ENTRY') asociada a una constraint concreta, buscando el nombre de
// columna en el mensaje de error (que MySQL siempre incluye junto al nombre
// de la constraint, p.ej. "...for key 'checkout_drafts.unique_checkout_drafts_idempotency_key'").
function isDuplicateEntryFor(err, keyNameFragment) {
  if (!err || err.code !== 'ER_DUP_ENTRY') return false;
  const message = err.sqlMessage || err.message || '';
  return message.includes(keyNameFragment);
}

// --- Access token ----------------------------------------------------------

// Contrato: CSPRNG de 32 bytes representado como 64 caracteres hexadecimales
// en minúscula (igual que genera Buffer#toString('hex')). Solo se exige el
// formato correcto, no se intenta evaluar estadísticamente aleatoriedad.
const ACCESS_TOKEN_FORMAT_REGEX = /^[0-9a-f]{64}$/;

// Utilidad server-side (tests, u otros callers internos). createOrGetDraft
// YA NO llama a esto por su cuenta: el caller (futuro checkout.js en B4)
// debe generar el token ANTES de la primera petición y reutilizar el MISMO
// valor en cualquier reintento, para no perder la capability si la
// respuesta HTTP de la primera petición se pierde antes de llegar al cliente.
function generateAccessToken() {
  return crypto.randomBytes(32).toString('hex');
}

function assertValidAccessTokenFormat(token) {
  if (typeof token !== 'string' || !ACCESS_TOKEN_FORMAT_REGEX.test(token)) {
    throw new DraftValidationError('accessToken debe ser un string hexadecimal de 64 caracteres (256 bits, minúsculas)');
  }
}

// Único valor que se persiste. No hay ruta de vuelta desde el hash al token.
function hashAccessToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new DraftValidationError('accessToken debe ser un string no vacío');
  }
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

// --- Fingerprint de selecciones ---------------------------------------------

// Mismo contrato de campos que ALLOWED_ITEM_KEYS de services/pricing.js,
// pero este módulo NO consulta BD ni precios: es una normalización pura de
// forma para producir un hash determinista. customerData queda deliberada-
// mente fuera de la firma de esta función (no forma parte del fingerprint).
const ALLOWED_FINGERPRINT_ITEM_KEYS = ['productId', 'quantity', 'modelId', 'variantOptionIds', 'extras', 'images', 'notes'];
const ALLOWED_FINGERPRINT_EXTRAS_KEYS = ['upscale', 'qr', 'adapter', 'qrMessage'];
const ALLOWED_FINGERPRINT_IMAGE_KEYS = ['url', 'filename', 'mimetype', 'size'];

function requirePositiveInteger(value, itemIndex, field) {
  const n = Number(value);
  if (typeof value === 'boolean' || !Number.isInteger(n) || n <= 0) {
    throw new DraftValidationError(`${field} debe ser un entero positivo`, { itemIndex, field });
  }
  return n;
}

function requireString(value, itemIndex, field) {
  if (typeof value !== 'string') {
    throw new DraftValidationError(`${field} debe ser un string`, { itemIndex, field });
  }
  return value;
}

// IDs normalizados: enteros positivos, orden ascendente determinista,
// duplicados colapsados (dos veces la misma opción no es una selección
// distinta a una vez). Valores no numéricos se rechazan explícitamente en
// vez de descartarse en silencio: a diferencia de public/js/cart.js (que
// normaliza carritos legacy de forma defensiva), esta es una función
// server-side que define el contrato canónico, no un parche de compatibilidad.
function normalizeIdList(rawIds, itemIndex, field) {
  if (rawIds === undefined || rawIds === null) return [];
  if (!Array.isArray(rawIds)) {
    throw new DraftValidationError(`${field} debe ser un array`, { itemIndex, field });
  }
  const seen = new Set();
  const result = [];
  rawIds.forEach((raw, idx) => {
    const n = requirePositiveInteger(raw, itemIndex, `${field}[${idx}]`);
    if (!seen.has(n)) {
      seen.add(n);
      result.push(n);
    }
  });
  result.sort((a, b) => a - b);
  return result;
}

function canonicalizeExtrasForFingerprint(rawExtras, itemIndex) {
  const extras = { upscale: false, qr: false, adapter: false, qrMessage: '' };
  if (rawExtras === undefined || rawExtras === null) return extras;
  if (typeof rawExtras !== 'object' || Array.isArray(rawExtras)) {
    throw new DraftValidationError('extras debe ser un objeto', { itemIndex, field: 'extras' });
  }
  for (const key of Object.keys(rawExtras)) {
    if (!ALLOWED_FINGERPRINT_EXTRAS_KEYS.includes(key)) {
      throw new DraftValidationError(`Campo no permitido "${key}" en extras`, { itemIndex, field: `extras.${key}` });
    }
  }
  for (const key of ['upscale', 'qr', 'adapter']) {
    if (rawExtras[key] !== undefined) {
      if (typeof rawExtras[key] !== 'boolean') {
        throw new DraftValidationError(`extras.${key} debe ser boolean`, { itemIndex, field: `extras.${key}` });
      }
      extras[key] = rawExtras[key];
    }
  }
  if (rawExtras.qrMessage !== undefined && rawExtras.qrMessage !== null) {
    extras.qrMessage = requireString(rawExtras.qrMessage, itemIndex, 'extras.qrMessage');
  }
  // Mismo contrato que services/pricing.js (P0E-B1): qrMessage solo importa
  // si qr=true. Normalizarlo a '' cuando qr=false evita que un residuo de
  // texto no visible cambie el fingerprint sin representar una selección distinta.
  if (!extras.qr) extras.qrMessage = '';
  return extras;
}

// El orden de las imágenes se preserva (puede tener significado para
// fabricación: cuál va primero). Solo se fija el orden de claves DENTRO de
// cada objeto-imagen, para que el mismo objeto lógico con claves en distinto
// orden JS produzca el mismo JSON canónico.
function canonicalizeImagesForFingerprint(rawImages, itemIndex) {
  if (rawImages === undefined || rawImages === null) return [];
  if (!Array.isArray(rawImages)) {
    throw new DraftValidationError('images debe ser un array', { itemIndex, field: 'images' });
  }
  return rawImages.map((img, idx) => {
    if (typeof img === 'string') return img;
    if (img && typeof img === 'object' && !Array.isArray(img) && typeof img.url === 'string') {
      for (const key of Object.keys(img)) {
        if (!ALLOWED_FINGERPRINT_IMAGE_KEYS.includes(key)) {
          throw new DraftValidationError(`images[${idx}] contiene un campo no permitido "${key}"`, { itemIndex, field: 'images' });
        }
      }
      const canonicalImg = { url: img.url };
      if (typeof img.filename === 'string') canonicalImg.filename = img.filename;
      if (typeof img.mimetype === 'string') canonicalImg.mimetype = img.mimetype;
      if (typeof img.size === 'number') canonicalImg.size = img.size;
      return canonicalImg;
    }
    throw new DraftValidationError(`images[${idx}] tiene un formato no reconocido`, { itemIndex, field: 'images' });
  });
}

function canonicalizeItemForFingerprint(rawItem, itemIndex) {
  if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
    throw new DraftValidationError('Cada selección debe ser un objeto', { itemIndex });
  }
  for (const key of Object.keys(rawItem)) {
    if (!ALLOWED_FINGERPRINT_ITEM_KEYS.includes(key)) {
      throw new DraftValidationError(`Campo no permitido "${key}" en selección`, { itemIndex, field: key });
    }
  }

  const productId = requirePositiveInteger(rawItem.productId, itemIndex, 'productId');
  const quantity = requirePositiveInteger(rawItem.quantity, itemIndex, 'quantity');
  const modelId = (rawItem.modelId === undefined || rawItem.modelId === null)
    ? null
    : requirePositiveInteger(rawItem.modelId, itemIndex, 'modelId');
  const variantOptionIds = normalizeIdList(rawItem.variantOptionIds, itemIndex, 'variantOptionIds');
  const extras = canonicalizeExtrasForFingerprint(rawItem.extras, itemIndex);
  const images = canonicalizeImagesForFingerprint(rawItem.images, itemIndex);
  const notes = (rawItem.notes === undefined || rawItem.notes === null)
    ? ''
    : requireString(rawItem.notes, itemIndex, 'notes');

  // Orden de claves fijo y constante en cada llamada: por eso el mismo
  // objeto lógico produce siempre el mismo JSON.stringify sin importar el
  // orden de claves con el que el llamante construyó el objeto original.
  return { productId, quantity, modelId, variantOptionIds, extras, images, notes };
}

/**
 * Calcula el fingerprint canónico (SHA-256 hex) de un array de selecciones.
 * Nunca confía en un fingerprint enviado por el cliente: esta es la única
 * función autorizada a producirlo. customerData no es un parámetro de esta
 * función porque nunca debe influir en el resultado (ver ticket P0E-B3 #7).
 */
function computeSelectionsFingerprint(selections) {
  if (!Array.isArray(selections) || selections.length === 0) {
    throw new DraftValidationError('selections debe ser un array no vacío para calcular el fingerprint');
  }
  const canonicalItems = selections.map((item, idx) => canonicalizeItemForFingerprint(item, idx));
  const canonicalJson = JSON.stringify(canonicalItems);
  return crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

// --- Validación de customerData ---------------------------------------------

// Mismos 7 campos que envía hoy public/js/checkout.js (getCustomerData) y
// mismos límites que las columnas customer_* ya existentes en `pedidos`
// (database/schema.sql). "country" SÍ se admite (ver informe de saneamiento
// de país que retiró la restricción del antiguo ticket #13): el límite de
// 2 caracteres es solo un tope de longitud defensivo -- la validación real
// de qué códigos se aceptan es la allowlist de abajo, no este límite.
const CUSTOMER_DATA_FIELDS = ['name', 'email', 'phone', 'address', 'city', 'zip', 'country'];
const CUSTOMER_FIELD_LIMITS = { name: 150, email: 150, phone: 30, address: 255, city: 120, zip: 20, country: 2 };
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateCustomerData(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DraftValidationError('customerData debe ser un objeto');
  }
  for (const key of Object.keys(raw)) {
    if (!CUSTOMER_DATA_FIELDS.includes(key)) {
      throw new DraftValidationError(`Campo no permitido en customerData: "${key}"`, { field: key });
    }
  }
  const normalized = {};
  for (const field of CUSTOMER_DATA_FIELDS) {
    const value = raw[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new DraftValidationError(`customerData.${field} es obligatorio`, { field });
    }
    const trimmed = value.trim();
    if (trimmed.length > CUSTOMER_FIELD_LIMITS[field]) {
      throw new DraftValidationError(
        `customerData.${field} supera el máximo de ${CUSTOMER_FIELD_LIMITS[field]} caracteres`,
        { field }
      );
    }
    normalized[field] = trimmed;
  }
  if (!EMAIL_REGEX.test(normalized.email)) {
    throw new DraftValidationError('customerData.email no tiene un formato válido', { field: 'email' });
  }
  // No basta con confiar en el <select> del frontend (sección 2 del informe
  // de saneamiento de país): esta es la ÚNICA comprobación real de qué
  // países se aceptan. Código ISO alpha-2 exacto (mayúsculas, sin alias de
  // nombre como "España") y perteneciente a la allowlist server-side.
  if (!isAllowedCheckoutCountry(normalized.country)) {
    throw new DraftValidationError(
      `customerData.country debe ser uno de: ${ALLOWED_CHECKOUT_COUNTRIES.join(', ')}`,
      { field: 'country' }
    );
  }
  return normalized;
}

// --- Utilidades internas de fila --------------------------------------------

function parseSnapshot(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') return JSON.parse(value);
  throw new DraftValidationError('snapshot_json corrupto o no reconocido');
}

function assertValidSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new DraftValidationError('snapshot debe ser un objeto');
  }
  try {
    JSON.stringify(snapshot);
  } catch (err) {
    throw new DraftValidationError(`snapshot no es serializable a JSON: ${err.message}`);
  }
}

// Nunca incluye access_token_hash: el hash no se expone fuera de este módulo.
function rowToDraft(row) {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    selectionsFingerprint: row.selections_fingerprint,
    status: row.status,
    snapshot: parseSnapshot(row.snapshot_json),
    stripePaymentIntentId: row.stripe_payment_intent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at
  };
}

// --- API pública -------------------------------------------------------------

/**
 * Crea un draft nuevo o, si idempotencyKey ya se usó con el MISMO
 * fingerprint de selecciones Y el MISMO access token, devuelve el
 * existente sin crear otro.
 *
 * El access token lo genera el CALLER antes de llamar (Web Crypto en el
 * futuro checkout.js de B4), no este servicio. Motivo: si la respuesta
 * HTTP de la primera creación se pierde antes de llegar al cliente, un
 * reintento con la misma idempotencyKey solo puede recuperar la capability
 * si el cliente ya conocía el token de antemano — un token generado
 * server-side y devuelto en la respuesta se perdería para siempre junto
 * con esa respuesta.
 *
 * La garantía definitiva contra condiciones de carrera es la restricción
 * UNIQUE(idempotency_key) en BD, no un SELECT previo: se intenta insertar
 * directamente y, si el INSERT pierde por esa constraint, se recupera al
 * ganador y se compara primero el fingerprint y después el access token.
 *
 * @returns {Promise<{draft: object, reused: boolean}>}
 *   Nunca devuelve el access token: el caller ya lo conoce (lo generó él).
 */
async function createOrGetDraft({ idempotencyKey, accessToken, selections, snapshot, expiresAt = null }, options = {}) {
  const dataAccess = resolveDataAccess(options);

  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0 || idempotencyKey.length > 255) {
    throw new DraftValidationError('idempotencyKey debe ser un string no vacío (máximo 255 caracteres)');
  }
  assertValidAccessTokenFormat(accessToken);
  if (expiresAt !== null && !(expiresAt instanceof Date)) {
    throw new DraftValidationError('expiresAt debe ser null o una Date');
  }

  const selectionsFingerprint = computeSelectionsFingerprint(selections);
  assertValidSnapshot(snapshot);

  const accessTokenHash = hashAccessToken(accessToken);
  const snapshotJson = JSON.stringify(snapshot);

  let newId;
  try {
    newId = await dataAccess.insertDraft({
      idempotencyKey,
      selectionsFingerprint,
      accessTokenHash,
      snapshotJson,
      status: DRAFT_STATUS.CREATED,
      expiresAt
    });
  } catch (err) {
    if (!isDuplicateEntryFor(err, 'idempotency_key')) throw err;

    const existingRow = await dataAccess.findByIdempotencyKey(idempotencyKey);
    if (!existingRow) throw err; // estado inesperado: no ocultar el error original

    // Orden: primero fingerprint (conflicto de idempotencia = payload
    // distinto), después access token (conflicto de acceso = mismo intento
    // lógico pero credencial distinta/incorrecta).
    if (existingRow.selections_fingerprint !== selectionsFingerprint) {
      throw new DraftIdempotencyConflictError(
        `La idempotency_key "${idempotencyKey}" ya se usó con una selección distinta`,
        { idempotencyKey, existingDraftId: existingRow.id }
      );
    }

    if (existingRow.access_token_hash !== accessTokenHash) {
      // No se revela el draft ni el hash almacenado: solo que el token
      // presentado no es el que abrió este intento de checkout.
      throw new DraftAccessDeniedError(
        `La idempotency_key "${idempotencyKey}" ya se usó con un access token distinto`
      );
    }

    return { draft: rowToDraft(existingRow), reused: true };
  }

  const row = await dataAccess.findById(newId);
  return { draft: rowToDraft(row), reused: false };
}

async function getDraftById(id, options = {}) {
  const dataAccess = resolveDataAccess(options);
  const row = await dataAccess.findById(id);
  return row ? rowToDraft(row) : null;
}

async function getDraftByIdempotencyKey(idempotencyKey, options = {}) {
  const dataAccess = resolveDataAccess(options);
  const row = await dataAccess.findByIdempotencyKey(idempotencyKey);
  return row ? rowToDraft(row) : null;
}

async function getDraftByAccessToken(accessToken, options = {}) {
  const dataAccess = resolveDataAccess(options);
  const hash = hashAccessToken(accessToken);
  const row = await dataAccess.findByAccessTokenHash(hash);
  return row ? rowToDraft(row) : null;
}

// Comprobación de capacidad para un draft ya conocido (p.ej. cargado por
// id desde una URL), con comparación en tiempo constante del hash.
async function verifyAccessToken(accessToken, draftId, options = {}) {
  const dataAccess = resolveDataAccess(options);
  if (typeof accessToken !== 'string' || accessToken.length === 0) return false;
  const row = await dataAccess.findById(draftId);
  if (!row || !row.access_token_hash) return false;
  const candidate = Buffer.from(hashAccessToken(accessToken), 'hex');
  const stored = Buffer.from(row.access_token_hash, 'hex');
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

// Únicos estados en los que updateCustomerDataByAccessToken puede escribir.
const CUSTOMER_DATA_WRITABLE_STATUSES = [DRAFT_STATUS.CREATED, DRAFT_STATUS.PAYMENT_PENDING];

/**
 * Actualiza customerData dentro del snapshot de un draft, autenticado por
 * capability token (no por id secuencial). Rechaza tokens desconocidos y
 * drafts converted/expired. B3 permite la actualización en payment_pending;
 * B4A añade el bloqueo adicional si el PaymentIntent ya está succeeded
 * (services/checkout-payment.js#updateCheckoutCustomerData, ya que este
 * módulo no habla con Stripe).
 *
 * La autorización por estado forma parte de la ESCRITURA misma
 * (updateSnapshotIfStatusIn), no solo de esta lectura previa: si el draft
 * pasa a converted/expired en el instante entre este SELECT y ese UPDATE
 * (p.ej. una finalización concurrente ganando la carrera), la escritura
 * falla igualmente aunque esta comprobación inicial la hubiera dejado
 * pasar. Esta comprobación inicial es solo un fast-fail barato para el
 * caso común; la garantía real es la condición en el propio UPDATE.
 */
async function updateCustomerDataByAccessToken(accessToken, customerData, options = {}) {
  const dataAccess = resolveDataAccess(options);

  const normalized = validateCustomerData(customerData);
  const tokenHash = hashAccessToken(accessToken);
  const row = await dataAccess.findByAccessTokenHash(tokenHash);
  if (!row) throw new DraftAccessDeniedError('Access token no reconocido');

  if (row.status === DRAFT_STATUS.CONVERTED) {
    throw new DraftStateError(
      'No se puede modificar customerData: el draft ya fue convertido en pedido',
      { draftId: row.id, currentStatus: row.status }
    );
  }
  if (row.status === DRAFT_STATUS.EXPIRED) {
    throw new DraftStateError(
      'No se puede modificar customerData: el draft ha expirado',
      { draftId: row.id, currentStatus: row.status }
    );
  }

  const snapshot = parseSnapshot(row.snapshot_json);
  snapshot.customerData = normalized;

  const affectedRows = await dataAccess.updateSnapshotIfStatusIn(
    row.id, JSON.stringify(snapshot), CUSTOMER_DATA_WRITABLE_STATUSES
  );

  if (affectedRows === 0) {
    // La escritura perdió la carrera contra un cambio de estado
    // concurrente: se relee el estado real para lanzar el error correcto,
    // en vez de asumir éxito de una condición que ya no era cierta.
    const fresh = await dataAccess.findById(row.id);
    if (!fresh) throw new DraftNotFoundError(`Draft ${row.id} no encontrado`, { draftId: row.id });
    throw new DraftStateError(
      `No se puede modificar customerData: el draft está en estado "${fresh.status}"`,
      { draftId: row.id, currentStatus: fresh.status }
    );
  }

  const updated = await dataAccess.findById(row.id);
  return rowToDraft(updated);
}

/**
 * Asocia un PaymentIntent de Stripe a un draft SIN llamar a Stripe. Reglas:
 * sin PI previo -> asigna y pasa a payment_pending; mismo PI -> éxito
 * idempotente; otro PI -> conflicto; PI ya usado por otro draft -> conflicto
 * (capturado desde la violación de UNIQUE(stripe_payment_intent_id)).
 */
async function attachPaymentIntent(draftId, paymentIntentId, options = {}) {
  const dataAccess = resolveDataAccess(options);

  if (typeof paymentIntentId !== 'string' || paymentIntentId.trim().length === 0) {
    throw new DraftValidationError('paymentIntentId debe ser un string no vacío');
  }

  const row = await dataAccess.findById(draftId);
  if (!row) throw new DraftNotFoundError(`Draft ${draftId} no encontrado`, { draftId });

  if (row.status === DRAFT_STATUS.CONVERTED || row.status === DRAFT_STATUS.EXPIRED) {
    throw new DraftStateError(
      `No se puede asociar un PaymentIntent a un draft en estado "${row.status}"`,
      { draftId, currentStatus: row.status }
    );
  }

  if (row.stripe_payment_intent_id) {
    if (row.stripe_payment_intent_id === paymentIntentId) {
      return rowToDraft(row); // éxito idempotente, no sobrescribe nada
    }
    throw new DraftPaymentIntentConflictError(
      `El draft ${draftId} ya tiene asociado otro PaymentIntent`,
      { draftId, existingPaymentIntentId: row.stripe_payment_intent_id, attemptedPaymentIntentId: paymentIntentId }
    );
  }

  try {
    await dataAccess.attachStripePaymentIntent(draftId, paymentIntentId, DRAFT_STATUS.PAYMENT_PENDING);
  } catch (err) {
    if (isDuplicateEntryFor(err, 'stripe_payment_intent_id')) {
      throw new DraftPaymentIntentConflictError(
        `El PaymentIntent ${paymentIntentId} ya está asociado a otro draft`,
        { draftId, attemptedPaymentIntentId: paymentIntentId }
      );
    }
    throw err;
  }

  const updated = await dataAccess.findById(draftId);
  return rowToDraft(updated);
}

/**
 * Transición de estado genérica, validada contra ALLOWED_TRANSITIONS. Una
 * llamada con el mismo estado actual es un no-op idempotente (no lanza).
 */
async function updateDraftStatus(draftId, newStatus, options = {}) {
  const dataAccess = resolveDataAccess(options);

  if (!Object.values(DRAFT_STATUS).includes(newStatus)) {
    throw new DraftValidationError(`Estado desconocido: ${newStatus}`);
  }

  const row = await dataAccess.findById(draftId);
  if (!row) throw new DraftNotFoundError(`Draft ${draftId} no encontrado`, { draftId });

  if (row.status === newStatus) {
    return rowToDraft(row);
  }

  const allowed = ALLOWED_TRANSITIONS[row.status] || new Set();
  if (!allowed.has(newStatus)) {
    throw new DraftStateError(
      `Transición de estado no permitida: "${row.status}" -> "${newStatus}"`,
      { draftId, currentStatus: row.status, attemptedStatus: newStatus }
    );
  }

  await dataAccess.updateStatus(draftId, newStatus);
  const updated = await dataAccess.findById(draftId);
  return rowToDraft(updated);
}

module.exports = {
  DRAFT_STATUS,
  DraftValidationError,
  DraftIdempotencyConflictError,
  DraftAccessDeniedError,
  DraftStateError,
  DraftPaymentIntentConflictError,
  DraftNotFoundError,
  computeSelectionsFingerprint,
  generateAccessToken,
  hashAccessToken,
  validateCustomerData,
  createOrGetDraft,
  getDraftById,
  getDraftByIdempotencyKey,
  getDraftByAccessToken,
  verifyAccessToken,
  updateCustomerDataByAccessToken,
  attachPaymentIntent,
  updateDraftStatus
};
