/*
  LITUM3D - Tests del motor canónico de pricing (services/pricing.js), P0E-B1.

  No usa BD real: inyecta un `dataAccess` falso con un catálogo fijo de
  fixtures (productos/modelos/opciones de variante), siguiendo el mismo
  patrón ligero de scripts/check-*.js ya usado en P0A/P0B/P0D (sin Jest/Mocha).

  Uso: node scripts/check-pricing-engine.js
*/
const assert = require('assert');
const { priceCartFromSelections, PricingValidationError } = require('../services/pricing');

// ---------------------------------------------------------------------
// Catálogo simulado (fixtures). Precios como string, igual que devuelve
// mysql2 para columnas DECIMAL en este proyecto.
// ---------------------------------------------------------------------
const PRODUCTS = {
  8: { id: 8, nombre: 'Litofanía Circular', precio: '49.95', activo: 1 },
  9: { id: 9, nombre: 'Producto Inactivo', precio: '20.00', activo: 0 },
  // Invariantes económicas (P0E-B1 refuerzo): catálogo mal configurado.
  20: { id: 20, nombre: 'Producto a coste cero', precio: '0.00', activo: 1 },
  21: { id: 21, nombre: 'Producto con precio corrupto', precio: 'abc', activo: 1 },
  22: { id: 22, nombre: 'Producto con precio fuera de rango seguro', precio: '999999999999999.99', activo: 1 }
};

const MODELS = {
  3: { id: 3, product_id: 8, nombre: 'Modelo Redondo', price_delta: '7.00', activo: 1 },
  4: { id: 4, product_id: 999, nombre: 'Modelo de otro producto', price_delta: '1.00', activo: 1 },
  5: { id: 5, product_id: 8, nombre: 'Modelo inactivo', price_delta: '1.00', activo: 0 },
  // Delta negativo legítimo, pero que al combinarse dejaría el producto en negativo.
  6: { id: 6, product_id: 8, nombre: 'Modelo con delta erróneo', price_delta: '-5000.00', activo: 1 }
};

const VARIANT_OPTIONS = {
  7: { id: 7, product_id: 8, variant_type_id: 2, variant_type_nombre: 'Base', option_nombre: 'Madera', price_delta: '5.00', option_activo: 1, type_activo: 1 },
  17: { id: 17, product_id: 8, variant_type_id: 2, variant_type_nombre: 'Base', option_nombre: 'Metal', price_delta: '8.00', option_activo: 1, type_activo: 1 },
  27: { id: 27, product_id: 8, variant_type_id: 3, variant_type_nombre: 'Forma', option_nombre: 'Cilíndrica', price_delta: '0.00', option_activo: 1, type_activo: 1 },
  37: { id: 37, product_id: 999, variant_type_id: 9, variant_type_nombre: 'Otro', option_nombre: 'X', price_delta: '1.00', option_activo: 1, type_activo: 1 },
  47: { id: 47, product_id: 8, variant_type_id: 2, variant_type_nombre: 'Base', option_nombre: 'Inactiva', price_delta: '1.00', option_activo: 0, type_activo: 1 },
  57: { id: 57, product_id: 8, variant_type_id: 6, variant_type_nombre: 'TipoInactivo', option_nombre: 'Y', price_delta: '1.00', option_activo: 1, type_activo: 0 }
};

function fakeDataAccess() {
  return {
    async getProduct(productId) { return PRODUCTS[productId] || null; },
    async getModel(modelId) { return MODELS[modelId] || null; },
    async getVariantOptions(optionIds) {
      return optionIds.map(id => VARIANT_OPTIONS[id]).filter(Boolean);
    }
  };
}

async function price(items) {
  return priceCartFromSelections(items, { dataAccess: fakeDataAccess() });
}

async function assertRejects(fn, description) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof PricingValidationError) return; // esperado
    throw new Error(`"${description}" lanzó un error inesperado (${err.constructor.name}): ${err.message}`);
  }
  throw new Error(`Se esperaba que "${description}" fuera rechazado y no lo fue`);
}

let checks = 0;
function check(condition, message) {
  checks++;
  assert.ok(condition, message);
}

// ---------------------------------------------------------------------
async function main() {
  // --- Precio base -------------------------------------------------
  {
    const result = await price([{ productId: 8, quantity: 1 }]);
    check(result.items[0].basePriceCents === 4995, 'Precio base: 49.95 EUR -> 4995 cents');
    check(result.items[0].unitPriceCents === 4995, 'Precio base: sin modelo/variantes/extras, unitPrice = basePrice');
    check(result.totals.totalCents === 4995, 'Total con una sola línea base');
    // EUR-ONLY-01: currency siempre viene de config/pricing.js, nunca hardcodeada aquí.
    check(result.currency === 'eur', 'El motor de pricing produce currency="eur" (fuente: config/pricing.js)');
  }

  // --- Modelo --------------------------------------------------------
  {
    const result = await price([{ productId: 8, quantity: 1, modelId: 3 }]);
    check(result.items[0].modelDeltaCents === 700, 'Modelo: price_delta de BD -> 700 rappen');
    check(result.items[0].unitPriceCents === 5695, 'Base 4995 + modelDelta 700 = 5695');
    check(result.items[0].modelName === 'Modelo Redondo', 'Nombre del modelo viene de BD');
  }

  // --- Variante --------------------------------------------------------
  {
    const result = await price([{ productId: 8, quantity: 1, variantOptionIds: [7] }]);
    check(result.items[0].unitPriceCents === 5495, 'Base 4995 + variantDelta 500 = 5495');
    check(result.items[0].variantSelections.length === 1, 'Una variante seleccionada');
    const v = result.items[0].variantSelections[0];
    check(v.variantTypeId === 2 && v.variantTypeName === 'Base' && v.optionId === 7 && v.optionName === 'Madera' && v.priceDeltaCents === 500,
      'variantSelections resuelto desde BD con los nombres reales de columnas');
  }

  // Variantes de distinto tipo coexisten (no se consolidan los dos sistemas)
  {
    const result = await price([{ productId: 8, quantity: 1, variantOptionIds: [7, 27] }]);
    check(result.items[0].unitPriceCents === 4995 + 500 + 0, 'Dos variantes de tipos distintos (Base+Forma) se suman');
    check(result.items[0].variantSelections.length === 2, 'Ambas variantes resueltas');
  }

  // --- Extras --------------------------------------------------------
  {
    const result = await price([{ productId: 8, quantity: 1, extras: { upscale: true, adapter: true } }]);
    check(result.items[0].extrasTotalCents === 900, 'upscale(500) + adapter(400) = 900');
    check(result.items[0].unitPriceCents === 4995 + 900, 'Base + extras');
    check(result.items[0].extras.qr === false, 'qr no seleccionado');
  }

  // --- Cantidad 1/2/3: subtotal = unitPrice * quantity, sin descuento -----
  {
    const r1 = await price([{ productId: 8, quantity: 1 }]);
    check(r1.items[0].lineSubtotalCents === 4995, 'Cantidad 1: lineSubtotal 4995*1, sin descuento');
    check(r1.totals.totalCents === 4995, 'Cantidad 1: totalCents = lineSubtotal (sin descuento)');

    const r2 = await price([{ productId: 8, quantity: 2 }]);
    check(r2.items[0].lineSubtotalCents === 9990, 'Cantidad 2: lineSubtotal 4995*2, sin descuento');
    check(r2.totals.totalCents === 9990, 'Cantidad 2: totalCents = lineSubtotal (sin descuento)');

    const r3 = await price([{ productId: 8, quantity: 3 }]);
    check(r3.items[0].lineSubtotalCents === 14985, 'Cantidad 3: lineSubtotal 4995*3, sin descuento');
    check(r3.totals.totalCents === 14985, 'Cantidad 3: totalCents = lineSubtotal (sin descuento)');
  }

  // --- Sin desglose fiscal (caso íntegro, línea compuesta) --------------
  // LITUM3D no desglosa IVA (VAT_PERCENT=0, ver config/pricing.js): con
  // este valor netCents === totalCents y taxCents === 0 siempre, para
  // cualquier combinación de modelo/variantes/extras/cantidad.
  {
    const result = await price([{
      productId: 8, quantity: 2, modelId: 3, variantOptionIds: [7],
      extras: { upscale: true, adapter: true }
    }]);
    const line = result.items[0];
    check(line.unitPriceCents === 7095, 'unitPrice = 4995+700+500+900 = 7095');
    check(line.lineSubtotalCents === 14190, 'lineSubtotal = 7095*2, sin descuento');
    check(result.totals.subtotalCents === 14190, 'subtotalCents');
    check(result.totals.totalCents === 14190, 'totalCents = subtotalCents (sin descuento)');
    check(result.totals.netCents === result.totals.totalCents, 'Sin IVA: netCents === totalCents');
    check(result.totals.taxCents === 0, 'Sin IVA: taxCents === 0');
  }

  // --- Seguridad: campos económicos heredados se rechazan, no se ignoran ---
  await assertRejects(
    () => price([{ productId: 8, quantity: 1, price: 1, basePrice: 1, priceDelta: -999999, extrasTotal: -999999 }]),
    'item con price/basePrice/priceDelta/extrasTotal debe rechazarse explícitamente'
  );
  await assertRejects(
    () => price([{ productId: 8, quantity: 1, extras: { upscale: true, price: 0 } }]),
    'extras.price (clave desconocida) debe rechazarse'
  );

  // --- Invariantes económicas (refuerzo P0E-B1) -----------------------
  await assertRejects(() => price([{ productId: 20, quantity: 1 }]), 'unitPriceCents <= 0 (producto a coste cero, sin deltas/extras) debe rechazarse');
  await assertRejects(
    () => price([{ productId: 8, quantity: 1, modelId: 6 }]),
    'delta de modelo negativo legítimo que deja unitPriceCents en negativo al combinarse debe rechazarse'
  );
  await assertRejects(() => price([{ productId: 21, quantity: 1 }]), 'precio de producto no numérico en BD ("abc") debe rechazarse');
  await assertRejects(() => price([{ productId: 22, quantity: 1 }]), 'precio de producto fuera del rango de entero seguro tras convertir a rappen debe rechazarse');

  // --- qrMessage: normalización canónica cuando qr=false -----------------
  {
    const result = await price([{ productId: 8, quantity: 1, extras: { qr: false, qrMessage: 'texto antiguo' } }]);
    check(result.items[0].extras.qrMessage === '', 'qr:false + qrMessage no vacío se normaliza a "" en la salida canónica, no se rechaza');
  }

  // --- Cantidad inválida -----------------------------------------------
  await assertRejects(() => price([{ productId: 8, quantity: 0 }]), 'quantity 0');
  await assertRejects(() => price([{ productId: 8, quantity: -1 }]), 'quantity -1');
  await assertRejects(() => price([{ productId: 8, quantity: 1.5 }]), 'quantity 1.5 (no entero)');
  await assertRejects(() => price([{ productId: 8, quantity: 11 }]), 'quantity 11 (por encima del máximo)');
  await assertRejects(() => price([{ productId: 8, quantity: '5' }]), 'quantity como string');

  // --- Producto ----------------------------------------------------------
  await assertRejects(() => price([{ productId: 999999, quantity: 1 }]), 'producto inexistente');
  await assertRejects(() => price([{ productId: 9, quantity: 1 }]), 'producto inactivo');

  // --- Modelo --------------------------------------------------------
  await assertRejects(() => price([{ productId: 8, quantity: 1, modelId: 999999 }]), 'modelo inexistente');
  await assertRejects(() => price([{ productId: 8, quantity: 1, modelId: 4 }]), 'modelo de otro producto');
  await assertRejects(() => price([{ productId: 8, quantity: 1, modelId: 5 }]), 'modelo inactivo');

  // --- Variant options -----------------------------------------------
  await assertRejects(() => price([{ productId: 8, quantity: 1, variantOptionIds: [999999] }]), 'variante inexistente');
  await assertRejects(() => price([{ productId: 8, quantity: 1, variantOptionIds: [37] }]), 'variante de otro producto');
  await assertRejects(() => price([{ productId: 8, quantity: 1, variantOptionIds: [47] }]), 'variante inactiva');
  await assertRejects(() => price([{ productId: 8, quantity: 1, variantOptionIds: [57] }]), 'variante con tipo (variant_type) inactivo');
  await assertRejects(() => price([{ productId: 8, quantity: 1, variantOptionIds: [7, 17] }]), 'dos opciones del mismo variant_type_id (cardinalidad)');
  await assertRejects(() => price([{ productId: 8, quantity: 1, variantOptionIds: [7, 7] }]), 'IDs de variante duplicados');

  // --- Extras: allowlist y tipos --------------------------------------
  await assertRejects(() => price([{ productId: 8, quantity: 1, extras: { upscale: 'yes' } }]), 'extras.upscale no booleano');
  await assertRejects(() => price([{ productId: 8, quantity: 1, extras: { qr: true, qrMessage: 123 } }]), 'extras.qrMessage no string');

  // --- Imágenes / notas: validación estructural sin leer precios ------
  {
    const result = await price([{ productId: 8, quantity: 1, images: ['/uploads/custom/a.jpg', { url: '/uploads/custom/b.jpg', filename: 'b.jpg' }], notes: 'Centrar la cara' }]);
    check(result.items[0].images.length === 2, 'Imágenes válidas (string y objeto {url}) se conservan');
    check(result.items[0].notes === 'Centrar la cara', 'Notas se conservan tal cual (no económicas)');
  }
  await assertRejects(() => price([{ productId: 8, quantity: 1, images: ['a', 'b', 'c', 'd'] }]), 'más de 3 imágenes');
  await assertRejects(() => price([{ productId: 8, quantity: 1, images: 'no-es-array' }]), 'images no es array');
  await assertRejects(() => price([{ productId: 8, quantity: 1, images: [{ url: '/x.jpg', price: 999 }] }]), 'objeto de imagen con campo "price" desconocido debe rechazarse');

  console.log(`OK: ${checks} comprobaciones y todos los casos de rechazo esperados en el motor de pricing canónico.`);
}

main().catch(err => {
  console.error('FALLO en check-pricing-engine.js:', err.message);
  process.exit(1);
});
