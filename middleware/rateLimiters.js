// Rate limiting (P0-SECURITY-01, secciones 20-26).
//
// Solo dos endpoints necesitan un limitador nuevo en este ticket:
//   - POST /admin/login       (brute force de credenciales)
//   - POST /api/uploads/custom (abuso de upload anónimo)
//
// Deliberadamente NO se aplica a: webhook de Stripe (reintentos legítimos
// firmados por Stripe), create-payment-intent/confirm-payment/customer-data
// (la idempotencia de checkout_drafts + PaymentIntent ya protege duplicados;
// un limitador agresivo aquí rompería reintentos/3DS), preview de imágenes
// (la capability token ya es la barrera).
//
// Store: en memoria (default de express-rate-limit), igual que MemoryStore de
// express-session -- válido mientras el despliegue sea una sola instancia
// (ver ecosystem.config.cjs: instances:1). Si el proyecto pasa a
// multi-instancia, este contador deja de ser global y hay que sustituirlo por
// un store compartido (Redis) -- fuera del alcance de este ticket (sección 39).
//
// Se exponen como FACTORÍAS (no singletons) para que los tests puedan crear
// instancias con ventana/máximo pequeños sin esperar minutos reales
// (sección 37/38), y las rutas reales usan una única instancia de cada una
// (loginLimiter/uploadLimiter) para que el conteo sea compartido entre
// peticiones reales.
const rateLimit = require('express-rate-limit');

// Respuesta 429 uniforme, sin stack ni detalles internos (sección 40).
function rateLimitHandler(req, res) {
  res.status(429).json({ error: 'Demasiados intentos. Inténtalo de nuevo más tarde.' });
}

// Login: pocos intentos por IP en una ventana corta. skipSuccessfulRequests
// evita penalizar a un admin que ya ha iniciado sesión correctamente antes en
// la misma ventana (solo cuentan los fallos). 10 intentos/15 min es
// suficiente para un despiste de contraseña real sin abrir la puerta a
// brute force práctico contra un hash bcrypt.
function createLoginLimiter(opts = {}) {
  return rateLimit({
    windowMs: opts.windowMs ?? 15 * 60 * 1000,
    limit: opts.limit ?? 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: rateLimitHandler
  });
}

// Upload anónimo: hasta 3 imágenes por request ya limitadas a 10MB/archivo
// (services/uploads-storage.js). 20 requests/15 min por IP permite a un
// cliente normal configurar varios productos (hasta 60 imágenes) sin
// bloquearse, mientras acota el abuso de almacenamiento/disco.
function createUploadLimiter(opts = {}) {
  return rateLimit({
    windowMs: opts.windowMs ?? 15 * 60 * 1000,
    limit: opts.limit ?? 20,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler
  });
}

const loginLimiter = createLoginLimiter();
const uploadLimiter = createUploadLimiter();

module.exports = { createLoginLimiter, createUploadLimiter, loginLimiter, uploadLimiter };
