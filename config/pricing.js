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

  // Porcentaje ENTERO de descuento aplicado a las unidades pares de cada
  // línea (2ª, 4ª, 6ª...). Entero para poder calcular en rappen sin depender
  // del literal decimal 0.15.
  SECOND_UNIT_DISCOUNT_PERCENT: 15,

  // Porcentaje de IVA ya incluido en los precios almacenados (precio bruto).
  // Entero para poder calcular en rappen sin depender del literal 1.21.
  VAT_PERCENT: 21
};
