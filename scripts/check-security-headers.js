/*
  LITUM3D - Test de regresión: hardening de cabeceras HTTP de seguridad
  (informe "auditoría y hardening MUY controlado de headers HTTP de
  seguridad").

  Mismo patrón que el resto de check-*.js de este repo: sin servidor HTTP
  real ni BD, se ejercita directamente middleware/securityHeaders.js con un
  req/res falsos (igual que check-session-security.js hace con sus
  middlewares), y se hacen comprobaciones de fuente sobre server.js para
  confirmar el wiring (app.disable('x-powered-by'), orden de montaje).

  Cubre:
  1) X-Powered-By ausente (app.disable, no un borrado caso por caso).
  2) X-Content-Type-Options: nosniff siempre presente.
  3) Referrer-Policy siempre presente.
  4) X-Frame-Options: DENY (protección real contra framing -- frame-ancestors
     vive en la CSP, que es Report-Only y por tanto NO bloquea nada todavía).
  5) Permissions-Policy coherente con el inventario real de capacidades
     usadas (payment permitido para Stripe, resto restringido).
  6) HSTS SOLO cuando req.secure && NODE_ENV=production -- nunca en HTTP/dev.
  7) Content-Security-Policy-Report-Only con el inventario exacto de
     recursos externos reales (Stripe, Google Fonts, Cloudinary, GTM) --
     nunca un Content-Security-Policy (enforced) todavía, y nunca
     default-src/script-src con "*" ni 'unsafe-eval'.
  8) Nunca Access-Control-Allow-Origin: * (ni ninguna variante de CORS
     abierto) en ninguna respuesta real de las rutas auditadas.
  9) Rutas públicas, Admin/login y una API JSON siguen respondiendo con las
     cabeceras de seguridad añadidas encima, sin perder su Content-Type.

  Uso: node scripts/check-security-headers.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); checks++; }

const ROOT = path.join(__dirname, '..');
function readFile(relPath) { return fs.readFileSync(path.join(ROOT, relPath), 'utf8'); }

// --- Fake res que registra setHeader() como un objeto plano -------------
function fakeRes() {
  const headers = {};
  return {
    headers,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    getHeader(name) { return headers[name.toLowerCase()]; }
  };
}

const { securityHeaders, CSP_DIRECTIVES, CSP_REPORT_ONLY_VALUE, PERMISSIONS_POLICY_VALUE, HSTS_MAX_AGE_SECONDS } = require('../middleware/securityHeaders');

// =======================================================================
// 1) X-Powered-By: server.js lo desactiva con app.disable, no con un
//    removeHeader disperso (fuente, no hace falta un servidor real).
// =======================================================================
function checkXPoweredByDisabledAtSource() {
  const src = readFile('server.js');
  ok(/app\.disable\(\s*['"]x-powered-by['"]\s*\)/.test(src), "server.js: app.disable('x-powered-by') está presente");
  ok(src.indexOf("app.disable('x-powered-by')") < src.indexOf('app.use(securityHeaders)') || /x-powered-by/i.test(src.split('app.use(securityHeaders)')[0]),
    'server.js: x-powered-by se desactiva ANTES de que se monte cualquier middleware (lo antes posible)');
}

// =======================================================================
// 2-6) Cabeceras que pone securityHeaders() sobre un req/res falsos
// =======================================================================
function checkHeaderersFromMiddlewareHttp() {
  const req = { secure: false };
  const res = fakeRes();
  let nextCalled = false;
  securityHeaders(req, res, () => { nextCalled = true; });

  ok(nextCalled, 'securityHeaders llama a next() (nunca bloquea la petición)');
  eq(res.getHeader('X-Content-Type-Options'), 'nosniff', 'X-Content-Type-Options: nosniff presente');
  eq(res.getHeader('Referrer-Policy'), 'strict-origin-when-cross-origin', 'Referrer-Policy presente y prudente');
  eq(res.getHeader('X-Frame-Options'), 'DENY', 'X-Frame-Options: DENY (protección real contra framing)');
  ok(!!res.getHeader('Permissions-Policy'), 'Permissions-Policy presente');
  ok(!res.getHeader('Strict-Transport-Security'), 'HTTP (req.secure=false): HSTS NO se envía');
}

function checkHstsOnlyUnderCorrectConditions() {
  const prevEnv = process.env.NODE_ENV;

  // HTTPS pero NODE_ENV no es production -> tampoco HSTS.
  process.env.NODE_ENV = 'test';
  let res = fakeRes();
  securityHeaders({ secure: true }, res, () => {});
  ok(!res.getHeader('Strict-Transport-Security'), 'HTTPS pero NODE_ENV!=production: HSTS NO se envía');

  // HTTPS + producción -> HSTS presente, conservador (sin preload/includeSubDomains).
  process.env.NODE_ENV = 'production';
  res = fakeRes();
  securityHeaders({ secure: true }, res, () => {});
  const hsts = res.getHeader('Strict-Transport-Security');
  ok(!!hsts, 'HTTPS + producción: HSTS presente');
  eq(hsts, `max-age=${HSTS_MAX_AGE_SECONDS}`, 'HSTS usa el max-age conservador documentado, sin más directivas');
  ok(!/preload/i.test(hsts), 'HSTS no incluye preload (instrucción explícita: no añadirlo a ciegas)');
  ok(!/includeSubDomains/i.test(hsts), 'HSTS no incluye includeSubDomains (instrucción explícita: no añadirlo a ciegas)');

  process.env.NODE_ENV = prevEnv;
}

// =======================================================================
// 7) CSP Report-Only: inventario exacto, nunca enforced, nunca wildcard/eval
// =======================================================================
function checkCspIsReportOnlyWithRealInventory() {
  const res = fakeRes();
  securityHeaders({ secure: true }, res, () => {});

  ok(!!res.getHeader('Content-Security-Policy-Report-Only'), 'Content-Security-Policy-Report-Only presente');
  ok(!res.getHeader('Content-Security-Policy'), 'Content-Security-Policy (enforced) NUNCA se envía en esta tarea -- CSP queda en Report-Only a propósito');

  const csp = CSP_REPORT_ONLY_VALUE;
  ok(!/default-src[^;]*\*/.test(csp), "CSP no usa default-src * (prohibido salvo necesidad demostrada)");
  const scriptSrcDirective = csp.split(';').find(d => d.trim().startsWith('script-src'));
  ok(!!scriptSrcDirective && !/\*/.test(scriptSrcDirective), "CSP: script-src no contiene ningún wildcard '*'");
  ok(!/unsafe-eval/.test(csp), "CSP no usa 'unsafe-eval' (sin necesidad demostrada)");

  // Recursos externos reales, verificados por auditoría de código:
  ok(csp.includes('https://js.stripe.com'), 'CSP permite https://js.stripe.com (script-src y frame-src, checkout real)');
  ok(csp.includes('https://api.stripe.com'), 'CSP permite https://api.stripe.com en connect-src (requisito documentado de Stripe.js v3)');
  ok(csp.includes('https://fonts.googleapis.com'), 'CSP permite https://fonts.googleapis.com (styles.css usa @import real)');
  ok(csp.includes('https://fonts.gstatic.com'), 'CSP permite https://fonts.gstatic.com en font-src (origen real de la fuente)');
  ok(csp.includes('https://res.cloudinary.com'), 'CSP permite https://res.cloudinary.com en img-src (imágenes de producto/galería reales)');
  ok(csp.includes('https://www.googletagmanager.com'), 'CSP permite GTM en script-src (cookie-banner.js#loadAnalytics es código vivo alcanzable)');

  // Directivas de contención que SÍ se pueden aplicar sin riesgo de romper nada:
  ok(csp.includes("object-src 'none'"), "CSP: object-src 'none'");
  ok(csp.includes("base-uri 'self'"), "CSP: base-uri 'self'");
  ok(csp.includes("form-action 'self'"), "CSP: form-action 'self' (auditado: ningún form externo real)");
  ok(csp.includes("frame-ancestors 'none'"), "CSP: frame-ancestors 'none' (documentado; el bloqueo real lo da X-Frame-Options)");
}

// =======================================================================
// 8) Permissions-Policy coherente con el inventario (nada de cámara/micro/
//    geo -- no se usan; payment permitido porque Stripe Elements lo necesita)
// =======================================================================
function checkPermissionsPolicyCoherent() {
  const p = PERMISSIONS_POLICY_VALUE;
  ok(p.includes('camera=()'), 'Permissions-Policy: camera=() (no usada en el código)');
  ok(p.includes('microphone=()'), 'Permissions-Policy: microphone=() (no usada en el código)');
  ok(p.includes('geolocation=()'), 'Permissions-Policy: geolocation=() (no usada en el código)');
  ok(/payment=\(self "https:\/\/js\.stripe\.com"\)/.test(p), 'Permissions-Policy: payment sigue disponible para self y Stripe (checkout usa Payment Element con wallets)');
}

// =======================================================================
// 9) No CORS abierto: ni el middleware ni ningún route file setean
//    Access-Control-Allow-Origin: *
// =======================================================================
function checkNoWildcardCors() {
  const res = fakeRes();
  securityHeaders({ secure: false }, res, () => {});
  ok(!res.getHeader('Access-Control-Allow-Origin'), 'securityHeaders no añade Access-Control-Allow-Origin');

  const filesToScan = ['server.js', ...fs.readdirSync(path.join(ROOT, 'routes')).map(f => `routes/${f}`), ...fs.readdirSync(path.join(ROOT, 'middleware')).map(f => `middleware/${f}`)];
  for (const file of filesToScan) {
    const src = readFile(file);
    ok(!/Access-Control-Allow-Origin['"]?\s*[,:]\s*['"]\*/.test(src), `${file}: no contiene Access-Control-Allow-Origin: *`);
  }
}

// =======================================================================
// 10) Rutas reales siguen respondiendo con las cabeceras añadidas encima,
//     sin perder su propio Content-Type (public, admin/login, API JSON)
// =======================================================================
function getRouteHandler(router, method, routePath) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  return layer ? layer.route.stack[layer.route.stack.length - 1].handle : null;
}

function checkRealRoutesStillRespondWithHeaders() {
  // Público: GET / (routes/index.js) sigue sirviendo el fichero real.
  const indexRouter = require('../routes/index');
  const homeHandler = getRouteHandler(indexRouter, 'get', '/');
  ok(!!homeHandler, 'GET / sigue registrado');
  let sentPath = null;
  const res1 = { sendFile: (p) => { sentPath = p; } };
  homeHandler({}, res1);
  ok(sentPath && sentPath.endsWith('index.html'), 'GET / sigue sirviendo views/index.html (las cabeceras de seguridad no interfieren con el routing)');

  // Admin/login: GET /admin/login sigue registrado (auditoría de fuente,
  // sin BD real -- mismo patrón que otros check-*.js de Admin).
  const adminSrc = readFile('routes/admin.js');
  ok(/router\.get\(\s*['"]\/login['"]/.test(adminSrc), "routes/admin.js: GET /login (montado en /admin) sigue registrado");

  // API JSON: una respuesta con securityHeaders aplicado conserva su propio
  // Content-Type (json) -- las cabeceras se AÑADEN, nunca sustituyen.
  const res2 = fakeRes();
  res2.setHeader('Content-Type', 'application/json; charset=utf-8');
  securityHeaders({ secure: true }, res2, () => {});
  eq(res2.getHeader('Content-Type'), 'application/json; charset=utf-8', 'una respuesta JSON conserva su Content-Type tras aplicar las cabeceras de seguridad');
  ok(!!res2.getHeader('X-Content-Type-Options'), 'y también recibe X-Content-Type-Options');
}

// =======================================================================
// 11) wiring en server.js: securityHeaders se monta lo antes posible, antes
//     de las rutas, para cubrir TODA respuesta (incluida Admin y /api)
// =======================================================================
function checkWiringCoversEverything() {
  const src = readFile('server.js');
  const securityIdx = src.indexOf('app.use(securityHeaders)');
  ok(securityIdx > -1, 'server.js monta securityHeaders');
  for (const marker of ["app.use(baseRoutes)", "app.use('/admin', adminRoutes)", "app.use('/api', paymentsRoutes)"]) {
    const idx = src.indexOf(marker);
    ok(idx > securityIdx, `server.js: securityHeaders se monta ANTES de "${marker}" (cubre esa ruta)`);
  }
}

function main() {
  checkXPoweredByDisabledAtSource();
  checkHeaderersFromMiddlewareHttp();
  checkHstsOnlyUnderCorrectConditions();
  checkCspIsReportOnlyWithRealInventory();
  checkPermissionsPolicyCoherent();
  checkNoWildcardCors();
  checkRealRoutesStillRespondWithHeaders();
  checkWiringCoversEverything();

  console.log(`OK: ${checks} comprobaciones de hardening de cabeceras HTTP de seguridad.`);
}

main();
