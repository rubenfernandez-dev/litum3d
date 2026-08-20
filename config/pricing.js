// LITUM3D - Configuración canónica server-side de pricing.
// Única fuente de verdad para constantes económicas que no viven en base de
// datos (precios de producto/modelo/variante SÍ viven en BD, ver services/pricing.js).
// Todos los importes están en cents/minor currency units enteros (1 EUR = 100
// cents) para evitar arrastrar floats por el motor de pricing; nunca en
// importes decimales. Código heredado y comentarios técnicos pueden seguir
// llamando "rappen" a estas unidades (nombre de variable/función sin cambiar
// para no generar un refactor masivo) — conceptualmente son cents/minor units.
//
// EUR-ONLY-01: LITUM3D opera con una única moneda activa (EUR). No hay
// conversión CHF<->EUR ni multi-currency; los importes numéricos existentes
// (antes expresados en CHF) se conservan exactamente, solo cambia la moneda.

module.exports = {
  // Moneda única activa del checkout. minúscula porque así la exige la API
  // de Stripe (paymentIntents.create({ currency })); para persistencia/
  // display se deriva en mayúsculas (ISO 4217) donde haga falta.
  currency: 'eur',

  // Precios de los extras opcionales del personalizador, en rappen.
  // upscale/qr/adapter son booleanos; qrMessage no tiene coste propio.
  extras: {
    upscale: 500,
    qr: 500,
    adapter: 400
  },

  // No VAT is currently itemized by LITUM3D. Product totals are final
  // catalog amounts; destination import taxes/duties are outside the
  // current pricing engine. VAT_PERCENT se mantiene en 0 (en vez de
  // eliminar la propiedad) porque services/pricing.js sigue calculando
  // netCents/taxCents a partir de ella (contrato interno existente); con 0,
  // netCents === totalCents y taxCents === 0, sin desglose fiscal alguno.
  VAT_PERCENT: 0
};
