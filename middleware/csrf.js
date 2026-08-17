// Protección CSRF para mutaciones autenticadas por sesión Admin (P0-SECURITY-01).
//
// Synchronizer token: un valor aleatorio (crypto.randomBytes) se guarda en
// req.session.csrfToken al hacer login (ver routes/admin.js) y se entrega al
// frontend vía GET /admin/api/csrf-token (requireAuth). El frontend lo reenvía
// en el header X-CSRF-Token en cada mutación; este middleware compara ambos
// valores con comparación de tiempo constante.
//
// NUNCA se aplica a: webhook de Stripe (firma propia), checkout público
// (accessToken de capability, no cookie de sesión), login (pre-sesión, ver
// sección 17 del ticket), upload anónimo.
//
// Debe montarse SIEMPRE después de requireAuth en cada ruta: así una petición
// sin sesión admin se rechaza por requireAuth (401) independientemente del
// token CSRF que traiga (sección 35, caso D).
const crypto = require('crypto');
const { parseHostFromUrl } = require('./sameOrigin');

function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

function timingSafeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) {
    return false;
  }
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Defensa adicional (sección 19): si el navegador envía Origin, debe
// coincidir con el host de esta petición. Nunca es la única defensa (el
// token de abajo lo es) -- una petición sin Origin (algunos navegadores/
// clientes legítimos) no se bloquea solo por esto.
function isOriginAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  if (!host) return true;
  const originHost = parseHostFromUrl(origin);
  return originHost !== null && originHost === host;
}

// No distingue "token ausente" de "token incorrecto" en el mensaje de
// respuesta (sección 16): ambos son simplemente 403, sin revelar el valor
// esperado ni loguear el token recibido completo.
function csrfProtection(req, res, next) {
  if (!isOriginAllowed(req)) {
    return res.status(403).json({ error: 'Origen no permitido' });
  }
  const sessionToken = req.session && req.session.csrfToken;
  const headerToken = req.headers['x-csrf-token'];
  if (!timingSafeEqualStrings(sessionToken, headerToken)) {
    return res.status(403).json({ error: 'Token CSRF inválido o ausente' });
  }
  next();
}

module.exports = { csrfProtection, generateCsrfToken, timingSafeEqualStrings, isOriginAllowed };
