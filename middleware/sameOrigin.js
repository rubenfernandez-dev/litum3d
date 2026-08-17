// Validación EXACTA same-origin (P0-SECURITY-01, cierre final, bloqueante 1).
//
// Un "origin" es scheme + host + puerto EFECTIVO (RFC 6454), no solo el
// host. Comparar solo `.host` (como hacía la versión anterior de este
// archivo) deja pasar http://litum3d.com o https://litum3d.com:444 como si
// fueran el mismo origin que https://litum3d.com -- no lo son. Aquí se
// compara SIEMPRE `new URL(x).origin` completo contra un origin esperado
// configurado server-side.
//
// Autoridad del origin esperado: BASE_URL / PUBLIC_BASE_URL -- la MISMA
// variable y la MISMA precedencia que ya usan routes/payments.js
// (sendConfirmationEmails) y config/seo.js/routes/seo.js para el dominio
// público real de esta app. No se introduce una variable nueva (APP_ORIGIN)
// porque ya existe una autoridad apropiada y duplicarla solo arriesga que
// las dos queden desincronizadas.
//
// Nunca se deriva del propio request (req.headers.host): un atacante
// controla tanto el Host como el Origin que envía, así que comparar uno
// contra el otro (como hacía la versión anterior) no demuestra nada -- la
// autoridad tiene que vivir en configuración server-side.
function parseOrigin(value) {
  if (typeof value !== 'string' || value.length === 0 || value.toLowerCase() === 'null') return null;
  try {
    return new URL(value).origin;
  } catch (e) {
    return null;
  }
}

// Compat: usado por middleware/csrf.js para su comprobación adicional (soft,
// solo-host, defensa EXTRA sobre el token CSRF real -- no es el mismo
// requisito que el same-origin estricto de aquí, así que se mantiene
// separado a propósito, ver ese archivo).
function parseHostFromUrl(value) {
  const origin = parseOrigin(value);
  return origin === null ? null : new URL(origin).host;
}

// allowLocalhostFallback:true permite un valor por defecto SOLO fuera de
// producción (sección 2: local/tests deben poder usar
// http://localhost:<puerto> sin configurar BASE_URL a mano). En producción
// esta función devuelve null si no hay una BASE_URL/PUBLIC_BASE_URL válida
// -- quien la llama (server.js) debe fail-fast, nunca debilitar la
// comparación para "que funcione".
function computeExpectedOrigin({ env = process.env, allowLocalhostFallback = false } = {}) {
  const raw = env.PUBLIC_BASE_URL || env.BASE_URL;
  const parsed = parseOrigin(raw);
  if (parsed !== null) return parsed;
  return allowLocalhostFallback ? `http://localhost:${env.PORT || 3000}` : null;
}

// Comparación EXACTA de origin (scheme+host+puerto efectivo). NUNCA
// includes()/endsWith()/host-only: "https://litum3d.com.evil.example",
// "https://www.litum3d.com" y "https://litum3d.com:444" son todos origins
// DISTINTOS de "https://litum3d.com".
function isSameOriginRequest(req, expectedOrigin) {
  if (!expectedOrigin) return false;

  const origin = req.headers.origin;
  if (origin) {
    const suppliedOrigin = parseOrigin(origin);
    return suppliedOrigin !== null && suppliedOrigin === expectedOrigin;
  }

  const referer = req.headers.referer || req.headers.referrer;
  if (referer) {
    const refererOrigin = parseOrigin(referer);
    return refererOrigin !== null && refererOrigin === expectedOrigin;
  }

  // Ni Origin ni Referer: no se puede demostrar same-origin -> false
  // (política explícita, sección 4: "si no puede demostrarse -> 403").
  return false;
}

function createRequireSameOrigin(expectedOrigin) {
  return function requireSameOrigin(req, res, next) {
    if (!isSameOriginRequest(req, expectedOrigin)) {
      return res.status(403).json({ error: 'Origen no permitido' });
    }
    next();
  };
}

// Singleton listo para usar (mismo patrón que middleware/csrf.js): calculado
// una vez al cargar el módulo, con fallback a localhost SOLO fuera de
// producción. El fail-fast real de producción vive en server.js (igual que
// SESSION_SECRET) -- si BASE_URL/PUBLIC_BASE_URL falta o es inválida ahí, el
// servidor no llega a arrancar, así que este valor nunca "falla en
// silencio" sirviendo tráfico con una comparación imposible de pasar.
const EXPECTED_ORIGIN = computeExpectedOrigin({ allowLocalhostFallback: process.env.NODE_ENV !== 'production' });
const requireSameOrigin = createRequireSameOrigin(EXPECTED_ORIGIN);

module.exports = {
  parseOrigin,
  parseHostFromUrl,
  computeExpectedOrigin,
  isSameOriginRequest,
  createRequireSameOrigin,
  requireSameOrigin,
  EXPECTED_ORIGIN
};
