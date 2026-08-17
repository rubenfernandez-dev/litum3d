// Parsing estricto de TRUST_PROXY (P0-SECURITY-01, hardening final, sección 16).
//
// Extraído de server.js para poder testearlo sin arrancar un servidor real.
// Reglas explícitas (nunca truthy/falsy "a la JS"):
//   - TRUST_PROXY ausente  -> 1 en producción (Nginx, un único hop -- ver
//     DEPLOYMENT-GUIDE.md), false en cualquier otro entorno.
//   - "false" / "true"     -> boolean real (comparación estricta, no
//     Boolean("false") que sería truthy).
//   - un entero (incl. negativos, aunque Express solo acepta >=0)
//     -> Number(...), para soportar más de un hop si la topología cambia.
//   - cualquier otra cosa  -> valor por defecto seguro + warning (nunca
//     lanza, nunca activa confianza en proxy "por si acaso").
function parseTrustProxy(rawValue, nodeEnv) {
  const safeDefault = nodeEnv === 'production' ? 1 : false;
  if (rawValue === undefined) return safeDefault;

  const normalized = String(rawValue).trim().toLowerCase();
  if (normalized === 'false') return false;
  if (normalized === 'true') return true;
  if (/^-?\d+$/.test(normalized)) return Number(normalized);

  console.warn(`[server] TRUST_PROXY="${rawValue}" no es un valor reconocido (usa true/false/un número entero de hops) -- usando el valor por defecto seguro para NODE_ENV=${nodeEnv || 'undefined'}.`);
  return safeDefault;
}

module.exports = { parseTrustProxy };
