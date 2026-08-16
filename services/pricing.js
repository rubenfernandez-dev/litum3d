/*
  LITUM3D - Motor canónico de pricing (P0E-B1).

  priceCartFromSelections(items) es la única función autorizada a decidir
  cuánto cuesta un carrito. Recibe SELECCIONES no confiables (qué producto,
  qué modelo, qué opciones de variante, qué extras, cantidad, imágenes,
  notas) y resuelve cada precio consultando la base de datos (producto,
  modelo, opción de variante) o config/pricing.js (extras, IVA, descuento).

  Nunca lee ni acepta price/basePrice/priceDelta/extrasTotal/total del
  llamante: cualquier clave económica "heredada" en el payload hace que la
  línea se rechace explícitamente (ver ALLOWED_ITEM_KEYS/ALLOWED_EXTRAS_KEYS),
  en vez de ignorarla en silencio, para detectar cuanto antes cualquier sitio
  que todavía envíe el contrato antiguo durante la migración.

  Conectado al checkout público desde P0E-B4B vía services/checkout-payment.js
  (POST /api/create-payment-intent): es la única autoridad de precio del
  checkout real. calculateCartTotals (routes/payments.js, basado en
  item.price del cliente) se eliminó en ese mismo ticket.

  IMPORTANTE: no muta nada en BD. Es de solo lectura.
*/

const { pool: defaultPool } = require('../config/db');
const pricingConfig = require('../config/pricing');

const ALLOWED_ITEM_KEYS = ['productId', 'quantity', 'modelId', 'variantOptionIds', 'extras', 'images', 'notes'];
const ALLOWED_EXTRAS_KEYS = ['upscale', 'qr', 'adapter', 'qrMessage'];
const BOOLEAN_EXTRA_KEYS = ['upscale', 'qr', 'adapter'];
// Forma real que devuelve POST /api/uploads/custom (routes/uploads.js): {filename,url,mimetype,size}.
const ALLOWED_IMAGE_OBJECT_KEYS = ['url', 'filename', 'mimetype', 'size'];

const MAX_QUANTITY = 10;
const MAX_IMAGES = 3;
const MAX_NOTES_LENGTH = 1000;
const MAX_QR_MESSAGE_LENGTH = 300;

class PricingValidationError extends Error {
  constructor(message, { itemIndex = null, field = null } = {}) {
    super(message);
    this.name = 'PricingValidationError';
    this.itemIndex = itemIndex;
    this.field = field;
  }
}

// --- Utilidades de dinero -----------------------------------------------

// Protección de invariante: cualquier importe en cents/minor units que
// maneje el motor debe ser un entero seguro (Number.isSafeInteger). Rechaza
// NaN, Infinity y valores fuera del rango entero seguro de JS, tanto si
// vienen de BD/config como si son el resultado de una suma. No rechaza
// negativos por sí solo: un delta de modelo/variante puede ser legítimamente
// negativo. (Código heredado puede seguir llamando "rappen" a estas unidades
// en nombres de función sin renombrar; conceptualmente son cents genéricos.)
function assertSafeIntegerCents(value, context) {
  if (!Number.isSafeInteger(value)) {
    throw new PricingValidationError(`Importe en cents no válido (${context}): ${value}`);
  }
  return value;
}

// Convierte un DECIMAL(10,2) de BD (que mysql2 puede devolver como string)
// a cents/minor units enteros. Único punto de conversión decimal -> entero.
// Exige explícitamente que el valor de entrada sea string o number antes de
// intentar convertirlo (evita coerciones sorprendentes de Number() sobre
// booleans/arrays/objetos), y que el resultado sea un entero seguro.
function centsFromDecimal(value, context = 'importe') {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new PricingValidationError(`${context}: se esperaba un valor numérico o convertible, recibido ${typeof value}`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new PricingValidationError(`${context}: valor no numérico/infinito (${value})`);
  }
  return assertSafeIntegerCents(Math.round(n * 100), context);
}

function sumCents(values) {
  return values.reduce((acc, v) => acc + v, 0);
}

// --- Acceso a datos (inyectable para tests, sin repository pattern) -----

function defaultDataAccess(pool) {
  return {
    async getProduct(productId) {
      const [rows] = await pool.query(
        'SELECT id, nombre, precio, activo FROM productos WHERE id = ? LIMIT 1',
        [productId]
      );
      return rows[0] || null;
    },
    async getModel(modelId) {
      const [rows] = await pool.query(
        'SELECT id, product_id, nombre, price_delta, activo FROM product_models WHERE id = ? LIMIT 1',
        [modelId]
      );
      return rows[0] || null;
    },
    async getVariantOptions(optionIds) {
      if (!optionIds.length) return [];
      const placeholders = optionIds.map(() => '?').join(',');
      const [rows] = await pool.query(
        `SELECT po.id, po.nombre AS option_nombre, po.price_delta, po.activo AS option_activo,
                pt.id AS variant_type_id, pt.nombre AS variant_type_nombre, pt.activo AS type_activo,
                pt.product_id AS product_id
         FROM product_variant_options po
         JOIN product_variant_types pt ON po.variant_type_id = pt.id
         WHERE po.id IN (${placeholders})`,
        optionIds
      );
      return rows;
    }
  };
}

// --- Validaciones de forma ------------------------------------------------

function assertPlainObject(value, itemIndex, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PricingValidationError(`${label} inválido: se esperaba un objeto`, { itemIndex });
  }
}

function assertAllowedKeys(obj, allowedKeys, itemIndex, label) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new PricingValidationError(
        `Campo no permitido "${key}" en ${label} (posible dato económico heredado del contrato antiguo)`,
        { itemIndex, field: key }
      );
    }
  }
}

function validateIntegerId(value, itemIndex, field) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new PricingValidationError(`${field} debe ser un entero positivo`, { itemIndex, field });
  }
  return value;
}

function validateQuantity(value, itemIndex) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new PricingValidationError('quantity debe ser un entero', { itemIndex, field: 'quantity' });
  }
  if (value < 1 || value > MAX_QUANTITY) {
    throw new PricingValidationError(`quantity debe estar entre 1 y ${MAX_QUANTITY}`, { itemIndex, field: 'quantity' });
  }
  return value;
}

function validateImages(rawImages, itemIndex) {
  if (rawImages === undefined || rawImages === null) return [];
  if (!Array.isArray(rawImages)) {
    throw new PricingValidationError('images debe ser un array', { itemIndex, field: 'images' });
  }
  if (rawImages.length > MAX_IMAGES) {
    throw new PricingValidationError(`images admite como máximo ${MAX_IMAGES} elementos`, { itemIndex, field: 'images' });
  }
  // Solo se conserva la referencia (string, o el objeto real que devuelve
  // POST /api/uploads/custom: {filename,url,mimetype,size}). Cualquier otra
  // clave (p.ej. "price") se rechaza en vez de ignorarse: nunca se lee
  // ningún campo económico de estos objetos.
  return rawImages.map((img, idx) => {
    if (typeof img === 'string' && img.length > 0) return img;
    if (img && typeof img === 'object' && !Array.isArray(img) && typeof img.url === 'string') {
      for (const key of Object.keys(img)) {
        if (!ALLOWED_IMAGE_OBJECT_KEYS.includes(key)) {
          throw new PricingValidationError(`images[${idx}] contiene un campo no permitido "${key}"`, { itemIndex, field: 'images' });
        }
      }
      const safeImage = { url: img.url };
      if (typeof img.filename === 'string') safeImage.filename = img.filename;
      if (typeof img.mimetype === 'string') safeImage.mimetype = img.mimetype;
      if (typeof img.size === 'number') safeImage.size = img.size;
      return safeImage;
    }
    throw new PricingValidationError(`images[${idx}] tiene un formato no reconocido`, { itemIndex, field: 'images' });
  });
}

function validateNotes(rawNotes, itemIndex) {
  if (rawNotes === undefined || rawNotes === null) return '';
  if (typeof rawNotes !== 'string') {
    throw new PricingValidationError('notes debe ser string', { itemIndex, field: 'notes' });
  }
  if (rawNotes.length > MAX_NOTES_LENGTH) {
    throw new PricingValidationError(`notes supera el máximo de ${MAX_NOTES_LENGTH} caracteres`, { itemIndex, field: 'notes' });
  }
  return rawNotes;
}

function validateAndPriceExtras(rawExtras, itemIndex) {
  const extras = { upscale: false, qr: false, adapter: false, qrMessage: '' };

  if (rawExtras !== undefined && rawExtras !== null) {
    assertPlainObject(rawExtras, itemIndex, 'extras');
    assertAllowedKeys(rawExtras, ALLOWED_EXTRAS_KEYS, itemIndex, 'extras');

    for (const key of BOOLEAN_EXTRA_KEYS) {
      if (rawExtras[key] !== undefined) {
        if (typeof rawExtras[key] !== 'boolean') {
          throw new PricingValidationError(`extras.${key} debe ser boolean`, { itemIndex, field: `extras.${key}` });
        }
        extras[key] = rawExtras[key];
      }
    }

    if (rawExtras.qrMessage !== undefined) {
      if (typeof rawExtras.qrMessage !== 'string') {
        throw new PricingValidationError('extras.qrMessage debe ser string', { itemIndex, field: 'extras.qrMessage' });
      }
      if (rawExtras.qrMessage.length > MAX_QR_MESSAGE_LENGTH) {
        throw new PricingValidationError(
          `extras.qrMessage supera el máximo de ${MAX_QR_MESSAGE_LENGTH} caracteres`,
          { itemIndex, field: 'extras.qrMessage' }
        );
      }
      extras.qrMessage = rawExtras.qrMessage;
    }
  }

  // qrMessage solo tiene sentido si qr=true; se normaliza, no se rechaza.
  if (!extras.qr) extras.qrMessage = '';

  const extrasPricingCents = {
    upscale: assertSafeIntegerCents(pricingConfig.extras.upscale, 'config.extras.upscale'),
    qr: assertSafeIntegerCents(pricingConfig.extras.qr, 'config.extras.qr'),
    adapter: assertSafeIntegerCents(pricingConfig.extras.adapter, 'config.extras.adapter')
  };

  let extrasTotalCents = 0;
  if (extras.upscale) extrasTotalCents += extrasPricingCents.upscale;
  if (extras.qr) extrasTotalCents += extrasPricingCents.qr;
  if (extras.adapter) extrasTotalCents += extrasPricingCents.adapter;

  return { extras, extrasPricingCents, extrasTotalCents };
}

// --- Resolución de una línea ----------------------------------------------

async function priceLine(rawItem, itemIndex, dataAccess) {
  assertPlainObject(rawItem, itemIndex, 'item');
  assertAllowedKeys(rawItem, ALLOWED_ITEM_KEYS, itemIndex, 'item');

  const productId = validateIntegerId(rawItem.productId, itemIndex, 'productId');
  const quantity = validateQuantity(rawItem.quantity, itemIndex);

  const product = await dataAccess.getProduct(productId);
  if (!product) {
    throw new PricingValidationError(`Producto ${productId} no encontrado`, { itemIndex, field: 'productId' });
  }
  if (!product.activo) {
    throw new PricingValidationError(`Producto ${productId} no está activo`, { itemIndex, field: 'productId' });
  }
  const basePriceCents = centsFromDecimal(product.precio, `producto ${productId}: precio base`);

  // Modelo (product_models) - opcional.
  let modelId = null;
  let modelName = null;
  let modelDeltaCents = 0;
  if (rawItem.modelId !== undefined && rawItem.modelId !== null) {
    modelId = validateIntegerId(rawItem.modelId, itemIndex, 'modelId');
    const model = await dataAccess.getModel(modelId);
    if (!model) {
      throw new PricingValidationError(`Modelo ${modelId} no encontrado`, { itemIndex, field: 'modelId' });
    }
    if (model.product_id !== productId) {
      throw new PricingValidationError(`Modelo ${modelId} no pertenece al producto ${productId}`, { itemIndex, field: 'modelId' });
    }
    if (!model.activo) {
      throw new PricingValidationError(`Modelo ${modelId} no está activo`, { itemIndex, field: 'modelId' });
    }
    modelName = model.nombre;
    modelDeltaCents = centsFromDecimal(model.price_delta, `modelo ${modelId}: price_delta`);
  }

  // Variantes (product_variant_types/options) - opcional, sistema independiente del modelo.
  const variantSelections = [];
  let variantDeltaTotalCents = 0;
  if (rawItem.variantOptionIds !== undefined && rawItem.variantOptionIds !== null) {
    if (!Array.isArray(rawItem.variantOptionIds)) {
      throw new PricingValidationError('variantOptionIds debe ser un array', { itemIndex, field: 'variantOptionIds' });
    }
    const optionIds = rawItem.variantOptionIds.map((id, idx) =>
      validateIntegerId(id, itemIndex, `variantOptionIds[${idx}]`)
    );
    if (new Set(optionIds).size !== optionIds.length) {
      throw new PricingValidationError('variantOptionIds contiene IDs duplicados', { itemIndex, field: 'variantOptionIds' });
    }

    if (optionIds.length) {
      const rows = await dataAccess.getVariantOptions(optionIds);
      const byId = new Map(rows.map(r => [r.id, r]));
      const seenTypes = new Set();

      for (const optionId of optionIds) {
        const row = byId.get(optionId);
        if (!row) {
          throw new PricingValidationError(`Opción de variante ${optionId} no encontrada`, { itemIndex, field: 'variantOptionIds' });
        }
        if (row.product_id !== productId) {
          throw new PricingValidationError(`Opción de variante ${optionId} no pertenece al producto ${productId}`, { itemIndex, field: 'variantOptionIds' });
        }
        if (!row.option_activo) {
          throw new PricingValidationError(`Opción de variante ${optionId} no está activa`, { itemIndex, field: 'variantOptionIds' });
        }
        if (!row.type_activo) {
          throw new PricingValidationError(`El tipo de variante de la opción ${optionId} no está activo`, { itemIndex, field: 'variantOptionIds' });
        }
        if (seenTypes.has(row.variant_type_id)) {
          throw new PricingValidationError(
            `Más de una opción seleccionada para el mismo tipo de variante (${row.variant_type_id})`,
            { itemIndex, field: 'variantOptionIds' }
          );
        }
        seenTypes.add(row.variant_type_id);

        const priceDeltaCents = centsFromDecimal(row.price_delta, `opción de variante ${optionId}: price_delta`);
        variantDeltaTotalCents += priceDeltaCents;
        variantSelections.push({
          variantTypeId: row.variant_type_id,
          variantTypeName: row.variant_type_nombre,
          optionId: row.id,
          optionName: row.option_nombre,
          priceDeltaCents
        });
      }
    }
  }

  const { extras, extrasPricingCents, extrasTotalCents } = validateAndPriceExtras(rawItem.extras, itemIndex);
  const images = validateImages(rawItem.images, itemIndex);
  const notes = validateNotes(rawItem.notes, itemIndex);

  const unitPriceCents = basePriceCents + modelDeltaCents + variantDeltaTotalCents + extrasTotalCents;

  // Invariante de precio final: los deltas individuales pueden ser negativos
  // (catálogo legítimo), pero la combinación resultante para este producto
  // nunca puede ser gratis o negativa. Si lo es, es una configuración de
  // catálogo inconsistente, no una entrada de cliente válida.
  if (!Number.isSafeInteger(unitPriceCents) || unitPriceCents <= 0) {
    throw new PricingValidationError(
      `Configuración de precios inválida para el producto ${productId}: unitPriceCents=${unitPriceCents} (base=${basePriceCents}, modelo=${modelDeltaCents}, variantes=${variantDeltaTotalCents}, extras=${extrasTotalCents})`,
      { itemIndex, field: 'unitPriceCents' }
    );
  }

  const lineSubtotalCents = unitPriceCents * quantity;

  const discountedUnits = Math.floor(quantity / 2);
  const lineDiscountCents = Math.round(
    (unitPriceCents * pricingConfig.SECOND_UNIT_DISCOUNT_PERCENT * discountedUnits) / 100
  );

  if (!Number.isSafeInteger(lineSubtotalCents) || lineSubtotalCents <= 0) {
    throw new PricingValidationError(`lineSubtotalCents inválido para el producto ${productId}: ${lineSubtotalCents}`, { itemIndex, field: 'lineSubtotalCents' });
  }
  if (!Number.isSafeInteger(lineDiscountCents) || lineDiscountCents < 0) {
    throw new PricingValidationError(`lineDiscountCents inválido para el producto ${productId}: ${lineDiscountCents}`, { itemIndex, field: 'lineDiscountCents' });
  }
  if (lineDiscountCents >= lineSubtotalCents) {
    throw new PricingValidationError(
      `lineDiscountCents (${lineDiscountCents}) no puede ser mayor o igual que lineSubtotalCents (${lineSubtotalCents}) para el producto ${productId}`,
      { itemIndex, field: 'lineDiscountCents' }
    );
  }

  return {
    productId,
    productName: product.nombre,
    basePriceCents,
    modelId,
    modelName,
    modelDeltaCents,
    variantSelections,
    extras,
    extrasPricingCents,
    extrasTotalCents,
    unitPriceCents,
    quantity,
    lineSubtotalCents,
    lineDiscountCents,
    images,
    notes
  };
}

// --- Función principal ------------------------------------------------

/**
 * Calcula el pricing canónico de un carrito a partir de SELECCIONES no
 * confiables. Nunca usa ningún importe enviado por el llamante.
 *
 * @param {Array<object>} items - selecciones (ver ALLOWED_ITEM_KEYS)
 * @param {object} [options]
 * @param {object} [options.dataAccess] - acceso a datos inyectable (tests)
 * @param {object} [options.pool] - pool mysql2 alternativo (por defecto, config/db)
 * @returns {Promise<object>} resultado canónico (ver cabecera del archivo)
 */
async function priceCartFromSelections(items, options = {}) {
  const dataAccess = options.dataAccess || defaultDataAccess(options.pool || defaultPool);

  if (!Array.isArray(items) || items.length === 0) {
    throw new PricingValidationError('El carrito debe contener al menos un artículo');
  }

  const canonicalItems = [];
  for (let i = 0; i < items.length; i++) {
    canonicalItems.push(await priceLine(items[i], i, dataAccess));
  }

  const subtotalCents = sumCents(canonicalItems.map(l => l.lineSubtotalCents));
  const discountCents = sumCents(canonicalItems.map(l => l.lineDiscountCents));
  const shippingCents = 0;
  const totalCents = subtotalCents - discountCents + shippingCents;

  // IVA: extracción vía ratio entero (100 / (100+VAT_PERCENT)), no 1/1.21.
  const netCents = Math.round((totalCents * 100) / (100 + pricingConfig.VAT_PERCENT));
  const taxCents = totalCents - netCents;

  const totals = { subtotalCents, discountCents, shippingCents, totalCents, netCents, taxCents };
  assertTotalsInvariants(totals);

  return {
    schemaVersion: 1,
    currency: pricingConfig.currency,
    items: canonicalItems,
    totals
  };
}

// Última línea de defensa antes de devolver el resultado: si alguna de estas
// invariantes no se cumple, hay un error de cálculo o de configuración de
// catálogo, no un problema de validación de entrada del cliente.
function assertTotalsInvariants(totals) {
  const { subtotalCents, discountCents, shippingCents, totalCents, netCents, taxCents } = totals;

  if (!Number.isSafeInteger(subtotalCents) || subtotalCents <= 0) {
    throw new PricingValidationError(`subtotalCents inválido: ${subtotalCents}`);
  }
  if (!Number.isSafeInteger(discountCents) || discountCents < 0) {
    throw new PricingValidationError(`discountCents inválido: ${discountCents}`);
  }
  if (!Number.isSafeInteger(shippingCents) || shippingCents < 0) {
    throw new PricingValidationError(`shippingCents inválido: ${shippingCents}`);
  }
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
    throw new PricingValidationError(`totalCents inválido: ${totalCents}`);
  }
  if (!Number.isSafeInteger(netCents) || netCents < 0) {
    throw new PricingValidationError(`netCents inválido: ${netCents}`);
  }
  if (!Number.isSafeInteger(taxCents) || taxCents < 0) {
    throw new PricingValidationError(`taxCents inválido: ${taxCents}`);
  }
  if (netCents + taxCents !== totalCents) {
    throw new PricingValidationError(`netCents+taxCents (${netCents + taxCents}) no coincide con totalCents (${totalCents})`);
  }
}

module.exports = {
  priceCartFromSelections,
  PricingValidationError,
  centsFromDecimal
};
