// LITUM3D - Idiomas soportados para checkout/emails.
// Fuente única server-side: services/checkout-drafts.js#validateCustomerData
// la usa para normalizar customerData.locale antes de persistirlo en el
// draft/snapshot; services/email-template.js y services/order-emails.js la
// reutilizan para decidir qué copy mostrar. Mismo patrón que
// config/checkout-countries.js (allowlist + normalizador, fuente única).
//
// PAÍS es independiente de IDIOMA (ver informe de persistencia de locale):
// CH es DE/FR/IT, un FR puede comprar estando en CH, etc. -- normalizeLocale
// NUNCA debe derivarse de customerData.country, solo del locale explícito
// que envía el checkout (document.documentElement.lang, ver
// public/js/checkout.js#getCustomerData).
//
// normalizeLocale() solo selecciona una clave dentro de un objeto JS fijo en
// memoria (ver services/order-emails.js#COPY / email-template.js#LEGAL_PATHS):
// el valor normalizado NUNCA debe usarse para construir rutas de
// filesystem, requires dinámicos ni nombres de plantilla.
const ALLOWED_LOCALES = Object.freeze(['es', 'de', 'fr', 'en']);
const DEFAULT_LOCALE = 'es';

function normalizeLocale(value) {
  return typeof value === 'string' && ALLOWED_LOCALES.includes(value) ? value : DEFAULT_LOCALE;
}

module.exports = { ALLOWED_LOCALES, DEFAULT_LOCALE, normalizeLocale };
