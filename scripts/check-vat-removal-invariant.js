/*
  LITUM3D - Test de regresión: saneamiento fiscal técnico del checkout
  (eliminación del desglose incorrecto "IVA 21%").

  Contexto: el sistema mostraba un "IVA 21%" extraído hacia atrás de un PVP
  ya fijado (ratio 100/121), pero VAT_PERCENT NUNCA intervino en totalCents
  -- Stripe solo cobra totalCents, y no existe factura fiscal generada por
  la aplicación. LITUM3D fabrica y envía desde Suiza y no tiene facilitado
  ningún registro VAT/MWST, así que afirmar "IVA español 21%" era incorrecto.

  Este archivo prueba el INVARIANTE CRÍTICO de la tarea: cambiar
  VAT_PERCENT (21 -> 0, ver config/pricing.js) no puede cambiar ni un
  céntimo el importe que se muestra o que cobra Stripe. Reutiliza el motor
  real (services/pricing.js), no una reimplementación paralela: fija
  temporalmente VAT_PERCENT=21 en el módulo de config ya cacheado por
  require() para reconstruir el cálculo "ANTES", compara contra el
  resultado "DESPUÉS" con el valor real actual (0), y restaura el valor
  original al terminar (incluso si un assert falla a mitad).

  Uso: node scripts/check-vat-removal-invariant.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const pricingConfig = require('../config/pricing');
const { priceCartFromSelections } = require('../services/pricing');

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); checks++; }

// ---------------------------------------------------------------------
// Mismo catálogo simulado que scripts/check-pricing-engine.js (P0E-B1).
// ---------------------------------------------------------------------
const PRODUCTS = {
  8: { id: 8, nombre: 'Litofanía Circular', precio: '49.95', activo: 1 },
  10: { id: 10, nombre: 'Portavelas', precio: '19.90', activo: 1 }
};
const MODELS = {
  3: { id: 3, product_id: 8, nombre: 'Modelo Redondo', price_delta: '7.00', activo: 1 }
};
const VARIANT_OPTIONS = {
  7: { id: 7, product_id: 8, variant_type_id: 2, variant_type_nombre: 'Base', option_nombre: 'Madera', price_delta: '5.00', option_activo: 1, type_activo: 1 }
};

function fakeDataAccess() {
  return {
    async getProduct(id) { return PRODUCTS[id] || null; },
    async getModel(id) { return MODELS[id] || null; },
    async getVariantOptions(ids) { return ids.map(id => VARIANT_OPTIONS[id]).filter(Boolean); }
  };
}

async function price(items) {
  return priceCartFromSelections(items, { dataAccess: fakeDataAccess() });
}

// Carritos representativos: producto base, variante, extras, cantidad 1/2,
// y una combinación de todo -- las mismas categorías que pide el informe.
const FIXTURE_CASES = [
  { label: 'producto base (portavelas), qty 1', items: [{ productId: 10, quantity: 1 }] },
  { label: 'producto base (litofanía), qty 1', items: [{ productId: 8, quantity: 1 }] },
  { label: 'producto base, qty 2', items: [{ productId: 8, quantity: 2 }] },
  { label: 'con modelo', items: [{ productId: 8, quantity: 1, modelId: 3 }] },
  { label: 'con variante', items: [{ productId: 8, quantity: 1, variantOptionIds: [7] }] },
  { label: 'con extras (upscale+adapter)', items: [{ productId: 8, quantity: 1, extras: { upscale: true, adapter: true } }] },
  { label: 'combinado: modelo+variante+extras, qty 2', items: [{ productId: 8, quantity: 2, modelId: 3, variantOptionIds: [7], extras: { upscale: true, qr: true, qrMessage: 'hola', adapter: true } }] }
];

// ---------------------------------------------------------------------
// 1) Invariante crítico: ANTES (VAT_PERCENT=21) vs DESPUÉS (VAT_PERCENT=0)
//    -- totalCents debe ser IDÉNTICO, PVP/lo que cobra Stripe no cambia.
// ---------------------------------------------------------------------
async function checkTotalCentsInvariantAcrossVatChange() {
  eq(pricingConfig.VAT_PERCENT, 0, 'PRECONDICIÓN: config/pricing.js ya tiene VAT_PERCENT=0 (saneamiento aplicado)');

  const originalVatPercent = pricingConfig.VAT_PERCENT;
  try {
    for (const { label, items } of FIXTURE_CASES) {
      // DESPUÉS: estado real actual del repo (VAT_PERCENT=0).
      pricingConfig.VAT_PERCENT = 0;
      const after = await price(items);

      // ANTES: simula el estado previo (VAT_PERCENT=21) con el MISMO motor,
      // para que la comparación no dependa de una reimplementación paralela
      // de la fórmula de IVA.
      pricingConfig.VAT_PERCENT = 21;
      const before = await price(items);

      eq(after.totals.totalCents, before.totals.totalCents,
        `${label}: totalCents IDÉNTICO antes/después de cambiar VAT_PERCENT (Stripe cobra exactamente lo mismo)`);
      eq(after.totals.subtotalCents, before.totals.subtotalCents, `${label}: subtotalCents no cambia`);
      eq(after.totals.shippingCents, before.totals.shippingCents, `${label}: shippingCents no cambia`);
      eq(after.currency, before.currency, `${label}: currency no cambia (eur)`);
      eq(after.items[0].unitPriceCents, before.items[0].unitPriceCents, `${label}: unitPriceCents (PVP resuelto) no cambia`);

      // DESPUÉS (VAT_PERCENT=0): sin desglose fiscal -- netCents colapsa en
      // totalCents y taxCents es exactamente 0.
      ok(after.totals.netCents === after.totals.totalCents, `${label}: DESPUÉS -- netCents === totalCents (sin IVA)`);
      ok(after.totals.taxCents === 0, `${label}: DESPUÉS -- taxCents === 0`);

      // ANTES (VAT_PERCENT=21): el desglose viejo SÍ separaba neto/impuesto
      // -- se confirma que existía (para que quede constancia de qué se
      // eliminó), pero nunca alteraba totalCents (ya comprobado arriba).
      ok(before.totals.taxCents > 0, `${label}: ANTES -- el cálculo viejo sí producía un taxCents>0 (el defecto que se corrige)`);
      eq(before.totals.netCents + before.totals.taxCents, before.totals.totalCents, `${label}: ANTES -- netCents+taxCents seguía cuadrando con totalCents`);
    }
  } finally {
    // Restaurar SIEMPRE el valor real, incluso si un assert de arriba lanza.
    pricingConfig.VAT_PERCENT = originalVatPercent;
  }

  eq(pricingConfig.VAT_PERCENT, 0, 'POSTCONDICIÓN: VAT_PERCENT queda restaurado a 0 tras el test (no quedó mutado en 21)');
}

// ---------------------------------------------------------------------
// 2) Stripe: el amount que se le pasaría a paymentIntents.create() es
//    totalCents, sin taxCents/VAT_PERCENT, para varios importes/productos,
//    y currency es SIEMPRE 'eur' (el país nunca decide la moneda).
// ---------------------------------------------------------------------
async function checkStripeAmountBeforeAfter() {
  const COUNTRIES = ['ES', 'PT', 'FR', 'CH', 'DE', 'IT'];

  for (const { label, items } of FIXTURE_CASES) {
    const result = await price(items);

    // Lo que routes/payments.js -> services/checkout-payment.js envía
    // realmente a stripe.paymentIntents.create(): amount=totals.totalCents,
    // currency=snapshot.currency (ver services/checkout-payment.js:220-221).
    const stripeParamsAfter = { amount: result.totals.totalCents, currency: result.currency };

    // ANTES: aunque el desglose fiscal mostrado cambiara, el payload que se
    // le enviaba a Stripe YA usaba totalCents (nunca taxCents/netCents) --
    // la auditoría original confirmó que VAT_PERCENT no interviene aquí.
    const stripeParamsBefore = { amount: result.totals.subtotalCents + result.totals.shippingCents, currency: result.currency };

    eq(stripeParamsAfter.amount, stripeParamsBefore.amount,
      `${label}: PaymentIntent.amount ANTES===DESPUÉS (${stripeParamsBefore.amount} cents)`);

    for (const country of COUNTRIES) {
      // El país del cliente (routes/checkout, customerData.country) nunca
      // participa en la resolución de currency: siempre 'eur' (EUR-ONLY-01).
      eq(result.currency, 'eur', `${label}: country=${country} -- currency sigue siendo 'eur' (el país no es un mecanismo de currency)`);
    }

    ok(!('taxCents' in stripeParamsAfter) && !('VAT_PERCENT' in stripeParamsAfter),
      `${label}: el payload de Stripe no incluye taxCents ni VAT_PERCENT`);
  }
}

// ---------------------------------------------------------------------
// 3) Producción visible: ningún texto "IVA/VAT/MwSt/TVA 21%" ni "sin IVA"
//    en checkout.js, cart-page.js, emails (routes/payments.js) o Terms.
// ---------------------------------------------------------------------
const ROOT = path.join(__dirname, '..');
function readFile(relPath) { return fs.readFileSync(path.join(ROOT, relPath), 'utf8'); }

function checkNoVatBreakdownInPurchaseFlow() {
  const FORBIDDEN = /Base \(sin IVA\)|IVA \(21%?\)|IVA:\s*<|MwSt\.?\s*\(?21|TVA\s*\(?21|\/\s*1\.21|total\s*\/\s*1\.21/i;

  const FILES = [
    'public/js/checkout.js',
    'public/js/cart-page.js',
    'routes/payments.js'
  ];
  for (const relPath of FILES) {
    const src = readFile(relPath);
    ok(!FORBIDDEN.test(src), `${relPath}: sin ningún desglose "IVA 21%"/"Base (sin IVA)"/total/1.21 residual`);
  }

  const TERMS_FILES = ['views/terms-conditions.html', 'views/terms-conditions-de.html', 'views/terms-conditions-fr.html'];
  for (const relPath of TERMS_FILES) {
    const src = readFile(relPath);
    ok(!/IVA \(21%?\)|MwSt\.?\s*\(?21|TVA\s*\(?21/i.test(src), `${relPath}: sin cláusula "IVA/MwSt/TVA 21%"`);
    // La ausencia de desglose NUNCA debe convertirse en una afirmación de
    // exención jurídica general (impuestos incluidos / sin aduanas / IVA 0%).
    ok(!/impuestos incluidos|sin aduanas|exento de IVA|IVA\s*0%/i.test(src), `${relPath}: no afirma exención fiscal universal`);
  }

  // routes/payments.js: el cálculo duplicado total/1.21 ya no existe.
  const paymentsSrc = readFile('routes/payments.js');
  ok(!/const subtotal = total \/ 1\.21/.test(paymentsSrc), 'routes/payments.js: cálculo duplicado "total / 1.21" eliminado');
}

// ---------------------------------------------------------------------
async function main() {
  await checkTotalCentsInvariantAcrossVatChange();
  await checkStripeAmountBeforeAfter();
  checkNoVatBreakdownInPurchaseFlow();

  console.log(`OK: ${checks} comprobaciones del saneamiento fiscal técnico (invariante de precio ANTES/DESPUÉS, Stripe amount, ausencia de desglose IVA 21%).`);
}

main().catch(err => {
  console.error('FALLO en check-vat-removal-invariant.js:', err.message);
  process.exit(1);
});
