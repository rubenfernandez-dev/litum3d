// LITUM3D - Configuración canónica server-side de pricing.
// Única fuente de verdad para constantes económicas que no viven en base de
// datos (precios de producto/modelo/variante SÍ viven en BD, ver services/pricing.js).
// Todos los importes están en rappen enteros (1 CHF = 100 rappen) para evitar
// arrastrar floats por el motor de pricing; nunca en francos decimales.

module.exports = {
  // Moneda única que maneja hoy el checkout.
  currency: 'chf',

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
