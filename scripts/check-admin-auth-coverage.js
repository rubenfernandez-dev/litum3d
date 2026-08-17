/*
  LITUM3D - P0-SECURITY-01, sección 36: inventario de cobertura auth+CSRF.

  Cubre TODAS las rutas de routes/admin.js, routes/reviews.js, routes/usuarios.js,
  routes/pedidos.js, routes/contact.js y routes/estados.js -- productos.js y
  variantes.js ya están cubiertas por scripts/check-catalog-auth.js (que
  también verifica CSRF desde este ticket).

  Introspecciona el stack de cada router (misma técnica que
  check-catalog-auth.js): no hace falta un servidor HTTP real para probar que
  un middleware concreto (requireAuth/csrfProtection/loginLimiter) está
  CABLEADO en una ruta. El objetivo es impedir que alguien añada una ruta
  administrativa nueva sin auth+CSRF por accidente: cualquier ruta de
  escritura (POST/PUT/PATCH/DELETE) no presente en el mapa EXPECTED hace
  fallar el test (sección 36).

  Uso: node scripts/check-admin-auth-coverage.js
*/
const assert = require('assert');
const adminRouter = require('../routes/admin');
const reviewsRouter = require('../routes/reviews');
const usuariosRouter = require('../routes/usuarios');
const pedidosRouter = require('../routes/pedidos');
const contactRouter = require('../routes/contact');
const estadosRouter = require('../routes/estados');
const requireAuth = require('../middleware/requireAuth');
const { csrfProtection } = require('../middleware/csrf');
const { loginLimiter } = require('../middleware/rateLimiters');

let checked = 0;
function ok(cond, msg) { assert.ok(cond, msg); checked++; }

// auth: la ruta debe exigir requireAuth (independientemente del método).
// csrf: la ruta debe llevar csrfProtection (solo aplica a mutaciones autenticadas).
// rateLimited: la ruta debe llevar un rate limiter conocido (solo login).
const EXPECTED = [
  // ---- routes/admin.js (montado en /admin) ----
  { router: adminRouter, name: 'admin', method: 'post', path: '/variantes', auth: true, csrf: true },
  { router: adminRouter, name: 'admin', method: 'get', path: '/login', auth: false, csrf: false },
  { router: adminRouter, name: 'admin', method: 'post', path: '/login', auth: false, csrf: false, rateLimited: true },
  { router: adminRouter, name: 'admin', method: 'get', path: '/api/csrf-token', auth: true, csrf: false },
  { router: adminRouter, name: 'admin', method: 'get', path: '/account', auth: true, csrf: false },
  { router: adminRouter, name: 'admin', method: 'post', path: '/account', auth: true, csrf: true },
  { router: adminRouter, name: 'admin', method: 'get', path: '/dashboard', auth: true, csrf: false },
  { router: adminRouter, name: 'admin', method: 'get', path: '/api/dashboard', auth: true, csrf: false },
  { router: adminRouter, name: 'admin', method: 'put', path: '/pedidos/:id/estado', auth: true, csrf: true },
  { router: adminRouter, name: 'admin', method: 'get', path: '/pedidos/:id/detalle', auth: true, csrf: false },
  { router: adminRouter, name: 'admin', method: 'get', path: '/pedidos/:orderId/imagenes/:imageId', auth: true, csrf: false },
  { router: adminRouter, name: 'admin', method: 'get', path: '/pedidos/:id/historial', auth: true, csrf: false },
  { router: adminRouter, name: 'admin', method: 'post', path: '/logout', auth: true, csrf: true },
  { router: adminRouter, name: 'admin', method: 'post', path: '/migrate/historial', auth: true, csrf: true },
  { router: adminRouter, name: 'admin', method: 'get', path: '/products', auth: true, csrf: false },
  { router: adminRouter, name: 'admin', method: 'get', path: '/productos', auth: true, csrf: false },
  { router: adminRouter, name: 'admin', method: 'post', path: '/productos', auth: true, csrf: true },
  { router: adminRouter, name: 'admin', method: 'put', path: '/productos/:id', auth: true, csrf: true },
  { router: adminRouter, name: 'admin', method: 'delete', path: '/productos/:id', auth: true, csrf: true },
  { router: adminRouter, name: 'admin', method: 'get', path: '/productos/:id/modelos', auth: true, csrf: false },
  { router: adminRouter, name: 'admin', method: 'post', path: '/productos/:id/modelos', auth: true, csrf: true },
  { router: adminRouter, name: 'admin', method: 'put', path: '/productos/:productId/modelos/:modelId', auth: true, csrf: true },
  { router: adminRouter, name: 'admin', method: 'delete', path: '/productos/:productId/modelos/:modelId', auth: true, csrf: true },

  // ---- routes/reviews.js ----
  { router: reviewsRouter, name: 'reviews', method: 'get', path: '/api/reviews', auth: false, csrf: false },
  { router: reviewsRouter, name: 'reviews', method: 'post', path: '/api/reviews', auth: false, csrf: false },
  { router: reviewsRouter, name: 'reviews', method: 'get', path: '/api/admin/reviews', auth: true, csrf: false },
  { router: reviewsRouter, name: 'reviews', method: 'post', path: '/api/admin/reviews', auth: true, csrf: true },
  { router: reviewsRouter, name: 'reviews', method: 'patch', path: '/api/admin/reviews/:id', auth: true, csrf: true },
  { router: reviewsRouter, name: 'reviews', method: 'delete', path: '/api/admin/reviews/:id', auth: true, csrf: true },

  // ---- routes/usuarios.js (legacy CRUD, PII, sin consumidor real -- sección 11) ----
  { router: usuariosRouter, name: 'usuarios', method: 'get', path: '/api/usuarios', auth: true, csrf: false },
  { router: usuariosRouter, name: 'usuarios', method: 'get', path: '/api/usuarios/:id', auth: true, csrf: false },
  { router: usuariosRouter, name: 'usuarios', method: 'post', path: '/api/usuarios', auth: true, csrf: true },
  { router: usuariosRouter, name: 'usuarios', method: 'put', path: '/api/usuarios/:id', auth: true, csrf: true },
  { router: usuariosRouter, name: 'usuarios', method: 'delete', path: '/api/usuarios/:id', auth: true, csrf: true },

  // ---- routes/pedidos.js (legacy CRUD, PII, sin consumidor real -- sección 11) ----
  { router: pedidosRouter, name: 'pedidos', method: 'get', path: '/api/pedidos', auth: true, csrf: false },
  { router: pedidosRouter, name: 'pedidos', method: 'get', path: '/api/pedidos/:id', auth: true, csrf: false },
  { router: pedidosRouter, name: 'pedidos', method: 'post', path: '/api/pedidos', auth: true, csrf: true },
  { router: pedidosRouter, name: 'pedidos', method: 'put', path: '/api/pedidos/:id/estado', auth: true, csrf: true },

  // ---- routes/contact.js ----
  { router: contactRouter, name: 'contact', method: 'get', path: '/api/contactos', auth: true, csrf: false },
  { router: contactRouter, name: 'contact', method: 'get', path: '/api/contactos/:id', auth: true, csrf: false },
  { router: contactRouter, name: 'contact', method: 'post', path: '/api/contact', auth: false, csrf: false },
  { router: contactRouter, name: 'contact', method: 'put', path: '/api/contactos/:id/respondido', auth: true, csrf: true },

  // ---- routes/estados.js ----
  { router: estadosRouter, name: 'estados', method: 'get', path: '/api/estados', auth: false, csrf: false },
  { router: estadosRouter, name: 'estados', method: 'post', path: '/api/estados', auth: true, csrf: true }
];

function findRouteLayer(router, method, routePath) {
  return router.stack.find(layer => layer.route && layer.route.path === routePath && layer.route.methods[method]);
}
function routeHasMiddleware(layer, fn) {
  return layer.route.stack.some(l => l.handle === fn);
}

function checkRouteWiring() {
  for (const spec of EXPECTED) {
    const layer = findRouteLayer(spec.router, spec.method, spec.path);
    ok(layer, `Ruta no encontrada: ${spec.method.toUpperCase()} ${spec.path} en ${spec.name}.js (¿se renombró o se eliminó?)`);

    const hasAuth = routeHasMiddleware(layer, requireAuth);
    if (spec.auth) {
      ok(hasAuth, `FALTA requireAuth: ${spec.method.toUpperCase()} ${spec.path} (${spec.name}.js)`);
    } else {
      ok(!hasAuth, `requireAuth de más en ruta pública por diseño: ${spec.method.toUpperCase()} ${spec.path} (${spec.name}.js)`);
    }

    const hasCsrf = routeHasMiddleware(layer, csrfProtection);
    if (spec.csrf) {
      ok(hasCsrf, `FALTA csrfProtection en mutación autenticada: ${spec.method.toUpperCase()} ${spec.path} (${spec.name}.js)`);
    } else {
      ok(!hasCsrf, `csrfProtection de más en ruta que no debería llevarlo: ${spec.method.toUpperCase()} ${spec.path} (${spec.name}.js)`);
    }

    if (spec.rateLimited) {
      const hasLimiter = routeHasMiddleware(layer, loginLimiter);
      ok(hasLimiter, `FALTA loginLimiter: ${spec.method.toUpperCase()} ${spec.path} (${spec.name}.js)`);
    }
  }

  // Exhaustividad: ninguna ruta de escritura (POST/PUT/PATCH/DELETE) de estos
  // 6 routers puede quedar fuera del mapa EXPECTED (sección 36: impedir que
  // una ruta nueva se añada sin pasar por esta auditoría).
  const routersByName = [
    ['admin', adminRouter], ['reviews', reviewsRouter], ['usuarios', usuariosRouter],
    ['pedidos', pedidosRouter], ['contact', contactRouter], ['estados', estadosRouter]
  ];
  for (const [name, router] of routersByName) {
    for (const layer of router.stack) {
      if (!layer.route) continue;
      const methods = Object.keys(layer.route.methods);
      const isWrite = methods.some(m => ['post', 'put', 'patch', 'delete'].includes(m));
      if (!isWrite) continue;
      const covered = EXPECTED.some(spec => spec.name === name && spec.path === layer.route.path && methods.includes(spec.method));
      ok(covered, `Ruta de escritura no auditada por este test: ${methods.join(',').toUpperCase()} ${layer.route.path} (${name}.js) — añádela al mapa EXPECTED`);
    }
  }

  // Y ninguna ruta GET sensible (expone PII/estado interno) puede faltar del
  // mapa tampoco -- a diferencia de check-catalog-auth.js, aquí SÍ auditamos
  // GETs porque varias de estas rutas devuelven pedidos/usuarios/contactos
  // completos, no catálogo público.
  const sensitiveGetPrefixes = {
    admin: ['/api/csrf-token', '/account', '/dashboard', '/api/dashboard', '/pedidos', '/products', '/productos'],
    usuarios: ['/api/usuarios'],
    pedidos: ['/api/pedidos'],
    contact: ['/api/contactos']
  };
  for (const [name, router] of routersByName) {
    const prefixes = sensitiveGetPrefixes[name];
    if (!prefixes) continue;
    for (const layer of router.stack) {
      if (!layer.route || !layer.route.methods.get) continue;
      const routePath = layer.route.path;
      const isSensitive = prefixes.some(p => routePath === p || routePath.startsWith(p + '/'));
      if (!isSensitive) continue;
      const covered = EXPECTED.some(spec => spec.name === name && spec.path === routePath && spec.method === 'get');
      ok(covered, `GET sensible no auditado: GET ${routePath} (${name}.js) — añádelo al mapa EXPECTED`);
    }
  }
}

function main() {
  checkRouteWiring();
  console.log(`OK: ${checked} comprobaciones de cobertura auth+CSRF sobre admin/reviews/usuarios/pedidos/contact/estados.`);
}

main();
