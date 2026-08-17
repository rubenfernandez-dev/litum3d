/*
  LITUM3D - P0-SECURITY-01: rate limiting (secciones 20-26, 37-38).

  Cubre:
    A) Login: brute force -- suficientes intentos fallidos seguidos ->
       eventualmente 429; tras expirar la ventana, vuelve a permitir.
       skipSuccessfulRequests: logins correctos repetidos NUNCA se bloquean.
    B) Upload anónimo: mismo patrón (límite -> 429 -> reset).
    C) Wiring estático: POST /admin/login tiene el loginLimiter real
       conectado; POST /api/uploads/custom tiene el uploadLimiter real
       conectado; el webhook de Stripe NO tiene ningún rate limiter.

  A/B usan factorías (createLoginLimiter/createUploadLimiter) con
  windowMs/limit PEQUEÑOS -- nunca los límites de producción -- para que el
  test sea determinista y rápido (cientos de ms), sin esperar minutos reales
  ni usar reloj simulado (que rompería el store interno de express-rate-limit).

  Uso: node scripts/check-rate-limiting.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { createLoginLimiter, createUploadLimiter, loginLimiter, uploadLimiter } = require('../middleware/rateLimiters');

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); checks++; }

const REPO_ROOT = path.join(__dirname, '..');

async function startServer(app) {
  return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
}
async function closeServer(server) {
  await new Promise((r) => server.close(r));
}

// =======================================================================
// A) Login limiter: brute force -> 429 -> reset tras la ventana
// =======================================================================
async function checkLoginLimiterBlocksRepeatedFailures() {
  const limiter = createLoginLimiter({ windowMs: 300, limit: 3 });
  const app = express();
  app.use(limiter);
  // Simula intentos de login FALLIDOS (401), el escenario real de brute force.
  app.get('/login-sim', (req, res) => res.status(401).json({ error: 'Credenciales inválidas' }));
  const server = await startServer(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (let i = 1; i <= 3; i++) {
      const res = await fetch(`${base}/login-sim`);
      eq(res.status, 401, `intento fallido ${i}/3 dentro del límite -> pasa (401 del "login", no bloqueado)`);
    }
    const blocked = await fetch(`${base}/login-sim`);
    eq(blocked.status, 429, 'sección 37 (obligatorio): tras suficientes intentos fallidos seguidos -> 429');
    const blockedBody = await blocked.json();
    ok(blockedBody.error && !/stack|at\s+\w+\s*\(/.test(JSON.stringify(blockedBody)), '429 sin stack trace ni detalles internos (sección 40)');

    await new Promise((r) => setTimeout(r, 350)); // esperar a que expire la ventana (300ms)
    const afterReset = await fetch(`${base}/login-sim`);
    eq(afterReset.status, 401, 'tras expirar la ventana, vuelve a permitir peticiones (no bloqueo indefinido, sección 21)');
  } finally {
    await closeServer(server);
  }
}

async function checkLoginLimiterNeverPenalizesSuccess() {
  const limiter = createLoginLimiter({ windowMs: 300, limit: 3 });
  const app = express();
  app.use(limiter);
  // Simula logins CORRECTOS repetidos (200): skipSuccessfulRequests debe
  // evitar que se cuenten contra el límite.
  app.get('/login-ok', (req, res) => res.status(200).json({ success: true }));
  const server = await startServer(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (let i = 1; i <= 6; i++) {
      const res = await fetch(`${base}/login-ok`);
      eq(res.status, 200, `login correcto repetido ${i}/6 nunca se bloquea (skipSuccessfulRequests, sección 21)`);
    }
  } finally {
    await closeServer(server);
  }
}

// =======================================================================
// B) Upload limiter: mismo patrón (todas las respuestas cuentan, sin skip)
// =======================================================================
async function checkUploadLimiterBlocksAbuseThenResets() {
  const limiter = createUploadLimiter({ windowMs: 300, limit: 3 });
  const app = express();
  app.use(limiter);
  app.post('/upload-sim', (req, res) => res.status(200).json({ ok: true }));
  const server = await startServer(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (let i = 1; i <= 3; i++) {
      const res = await fetch(`${base}/upload-sim`, { method: 'POST' });
      eq(res.status, 200, `upload ${i}/3 dentro del límite -> 200 (cliente normal configurando varios productos, sección 22)`);
    }
    const blocked = await fetch(`${base}/upload-sim`, { method: 'POST' });
    eq(blocked.status, 429, 'sección 38 (obligatorio): abuso claro de upload anónimo -> eventualmente 429');

    await new Promise((r) => setTimeout(r, 350));
    const afterReset = await fetch(`${base}/upload-sim`, { method: 'POST' });
    eq(afterReset.status, 200, 'tras expirar la ventana, vuelve a permitir uploads normales');
  } finally {
    await closeServer(server);
  }
}

// =======================================================================
// C) Wiring estático: las rutas reales usan los limitadores reales; el
//    webhook de Stripe NUNCA lleva un rate limiter genérico (sección 24).
// =======================================================================
function findRouteLayer(router, method, routePath) {
  return router.stack.find((layer) => layer.route && layer.route.path === routePath && layer.route.methods[method]);
}
function routeHasMiddleware(layer, fn) {
  return layer.route.stack.some((l) => l.handle === fn);
}

function checkStaticWiring() {
  const uploadsRouter = require('../routes/uploads');
  const uploadLayer = findRouteLayer(uploadsRouter, 'post', '/api/uploads/custom');
  ok(uploadLayer, 'se localizó POST /api/uploads/custom en routes/uploads.js');
  ok(routeHasMiddleware(uploadLayer, uploadLimiter), 'POST /api/uploads/custom tiene el uploadLimiter real conectado');

  const adminRouter = require('../routes/admin');
  const loginLayer = findRouteLayer(adminRouter, 'post', '/login');
  ok(loginLayer, 'se localizó POST /admin/login en routes/admin.js');
  ok(routeHasMiddleware(loginLayer, loginLimiter), 'POST /admin/login tiene el loginLimiter real conectado');

  // El webhook (router dedicado, sección 24/25) nunca debe llevar un rate
  // limiter genérico: comprobación de fuente, ya que createStripeWebhookRouter
  // construye el router en cada llamada (no hay una instancia estática que
  // introspeccionar de forma fiable sin invocarla con dependencias falsas).
  const paymentsSrc = fs.readFileSync(path.join(REPO_ROOT, 'routes', 'payments.js'), 'utf8');
  const webhookRouterFn = paymentsSrc.match(/function createStripeWebhookRouter[\s\S]*?\n}/);
  ok(webhookRouterFn, 'se localizó createStripeWebhookRouter en routes/payments.js');
  ok(!/rateLimit|Limiter/.test(webhookRouterFn[0]), 'CRÍTICO: el webhook de Stripe nunca lleva un rate limiter (reintentos legítimos de Stripe no deben perderse por 429)');

  // La preview de imágenes tampoco lleva un limiter nuevo (la capability es
  // la barrera principal, sección 25).
  const uploadsSrc = fs.readFileSync(path.join(REPO_ROOT, 'routes', 'uploads.js'), 'utf8');
  const previewRouteMatch = uploadsSrc.match(/router\.get\('\/api\/uploads\/custom\/preview\/:filename',[^\n]*/);
  ok(previewRouteMatch, 'se localizó GET /api/uploads/custom/preview/:filename');
  ok(!/Limiter/.test(previewRouteMatch[0]), 'la preview de imágenes no lleva un rate limiter nuevo (sección 25)');
}

// =======================================================================
async function main() {
  console.log('P0-SECURITY-01 - login limiter: brute force -> 429 -> reset');
  await checkLoginLimiterBlocksRepeatedFailures();
  console.log('P0-SECURITY-01 - login limiter: logins correctos nunca penalizados (skipSuccessfulRequests)');
  await checkLoginLimiterNeverPenalizesSuccess();
  console.log('P0-SECURITY-01 - upload limiter: abuso -> 429 -> reset');
  await checkUploadLimiterBlocksAbuseThenResets();
  console.log('P0-SECURITY-01 - wiring estático de rate limiters (login/upload real; webhook/preview sin limiter)');
  checkStaticWiring();
  console.log(`OK: ${checks} comprobaciones de rate limiting.`);
}

main().catch((err) => { console.error('FALLO:', err); process.exit(1); });
