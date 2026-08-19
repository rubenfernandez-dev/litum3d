// LITUM3D - Países admitidos para el envío del checkout público.
// Fuente única server-side: services/checkout-drafts.js#validateCustomerData
// la usa para rechazar cualquier código no soportado antes de que
// customerData.country llegue al draft/pedido. El <select> de
// views/checkout.html/checkout-de.html/checkout-fr.html NO es una
// validación real -- solo esta lista lo es.
//
// PAÍS es independiente de MONEDA: esto no afecta a config/pricing.js
// (currency: 'eur' sigue siendo la única moneda, para los seis países).
//
// Añadir un país aquí no basta por sí solo: hace falta además añadir su
// <option value="XX">...</option> en los tres checkout.html (mismo código,
// tres traducciones) para que sea seleccionable desde el frontend.
const ALLOWED_CHECKOUT_COUNTRIES = Object.freeze(['ES', 'PT', 'FR', 'CH', 'DE', 'IT']);

function isAllowedCheckoutCountry(code) {
  return typeof code === 'string' && ALLOWED_CHECKOUT_COUNTRIES.includes(code);
}

module.exports = { ALLOWED_CHECKOUT_COUNTRIES, isAllowedCheckoutCountry };
