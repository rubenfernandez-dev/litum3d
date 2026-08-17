/*
  LITUM3D - Verifica que las mutaciones del catálogo (productos y variantes)
  exigen sesión de admin, y que las lecturas públicas necesarias para la
  tienda/personalizador siguen siendo accesibles sin login (hallazgo P0D).

  No levanta un servidor HTTP real ni una base de datos: introspecciona el
  stack interno de los routers de Express (quién tiene requireAuth registrado
  en su cadena de middlewares) y prueba requireAuth() directamente como
  función pura con objetos req/res simulados. Esto prueba con certeza que el
  middleware está CABLEADO en cada ruta y que su lógica de sesión es correcta,
  aunque no reproduce una petición HTTP real de extremo a extremo.

  Uso: node scripts/check-catalog-auth.js
*/
const assert = require('assert');
const productos = require('../routes/productos');
const variantes = require('../routes/variantes');
const requireAuth = require('../middleware/requireAuth');
const { csrfProtection } = require('../middleware/csrf');

// Mapa de rutas esperadas: método + path -> debe exigir sesión de admin
// (protectedRoute) y, si la exige, si además debe llevar CSRF (P0-SECURITY-01,
// sección 14: toda mutación autenticada por sesión Admin debe llevarlo).
const EXPECTED = [
  // routes/productos.js
  { router: productos, name: 'productos', method: 'get', path: '/api/productos', protectedRoute: false },
  { router: productos, name: 'productos', method: 'get', path: '/api/productos/:id', protectedRoute: false },
  { router: productos, name: 'productos', method: 'get', path: '/api/productos/:id/modelos', protectedRoute: false },
  { router: productos, name: 'productos', method: 'post', path: '/api/productos', protectedRoute: true, csrf: true },
  { router: productos, name: 'productos', method: 'put', path: '/api/productos/:id', protectedRoute: true, csrf: true },
  { router: productos, name: 'productos', method: 'delete', path: '/api/productos/:id', protectedRoute: true, csrf: true },
  { router: productos, name: 'productos', method: 'get', path: '/api/galeria-estatica', protectedRoute: false },

  // routes/variantes.js
  { router: variantes, name: 'variantes', method: 'get', path: '/api/productos/:productId/variant-types', protectedRoute: false },
  { router: variantes, name: 'variantes', method: 'get', path: '/api/variant-types/:variantTypeId', protectedRoute: false },
  { router: variantes, name: 'variantes', method: 'get', path: '/api/variant-types/:variantTypeId/options', protectedRoute: false },
  { router: variantes, name: 'variantes', method: 'post', path: '/api/productos/:productId/variant-types', protectedRoute: true, csrf: true },
  { router: variantes, name: 'variantes', method: 'post', path: '/api/variant-types/:variantTypeId/options', protectedRoute: true, csrf: true },
  // Cálculo de precio: es un POST, pero solo lee y calcula, no muta nada. Debe seguir público
  // (lo usa el personalizador de shop.js/home.js/product-variants.js sin sesión).
  { router: variantes, name: 'variantes', method: 'post', path: '/api/productos/:productId/calculate-variant-price', protectedRoute: false },
  { router: variantes, name: 'variantes', method: 'put', path: '/api/variant-types/:variantTypeId', protectedRoute: true, csrf: true },
  { router: variantes, name: 'variantes', method: 'put', path: '/api/variant-options/:optionId', protectedRoute: true, csrf: true },
  { router: variantes, name: 'variantes', method: 'delete', path: '/api/variant-types/:variantTypeId', protectedRoute: true, csrf: true },
  { router: variantes, name: 'variantes', method: 'delete', path: '/api/variant-options/:optionId', protectedRoute: true, csrf: true }
];

function findRouteLayer(router, method, path) {
  return router.stack.find(layer =>
    layer.route &&
    layer.route.path === path &&
    layer.route.methods[method]
  );
}

function routeHasRequireAuth(layer) {
  return layer.route.stack.some(l => l.handle === requireAuth);
}

function routeHasCsrf(layer) {
  return layer.route.stack.some(l => l.handle === csrfProtection);
}

function checkRouteWiring() {
  let checked = 0;
  for (const spec of EXPECTED) {
    const layer = findRouteLayer(spec.router, spec.method, spec.path);
    assert.ok(layer, `Ruta no encontrada: ${spec.method.toUpperCase()} ${spec.path} en ${spec.name}.js (¿se renombró o se eliminó?)`);

    const hasAuth = routeHasRequireAuth(layer);
    if (spec.protectedRoute) {
      assert.ok(hasAuth, `FALTA requireAuth en mutación administrativa: ${spec.method.toUpperCase()} ${spec.path} (${spec.name}.js)`);
    } else {
      assert.ok(!hasAuth, `Lectura pública quedó protegida por error: ${spec.method.toUpperCase()} ${spec.path} (${spec.name}.js) — rompería la tienda/personalizador`);
    }

    const hasCsrf = routeHasCsrf(layer);
    if (spec.csrf) {
      assert.ok(hasCsrf, `FALTA csrfProtection en mutación autenticada: ${spec.method.toUpperCase()} ${spec.path} (${spec.name}.js) — P0-SECURITY-01 sección 14`);
    } else {
      assert.ok(!hasCsrf, `csrfProtection en una ruta que no debería llevarlo: ${spec.method.toUpperCase()} ${spec.path} (${spec.name}.js)`);
    }
    checked++;
  }

  // Ninguna ruta de escritura del catálogo se ha quedado fuera del mapa anterior.
  for (const [name, router] of [['productos', productos], ['variantes', variantes]]) {
    for (const layer of router.stack) {
      if (!layer.route) continue;
      const methods = Object.keys(layer.route.methods);
      const isWrite = methods.some(m => ['post', 'put', 'patch', 'delete'].includes(m));
      if (!isWrite) continue;
      const covered = EXPECTED.some(spec =>
        spec.name === name && spec.path === layer.route.path && methods.includes(spec.method)
      );
      assert.ok(covered, `Ruta de escritura no auditada por este test: ${methods.join(',').toUpperCase()} ${layer.route.path} (${name}.js) — añádela al mapa EXPECTED`);
    }
  }

  return checked;
}

function checkRequireAuthBehavior() {
  // Caso: sin sesión admin -> debe rechazar con 401 y NO continuar la cadena.
  let statusCode = null;
  let jsonBody = null;
  let nextCalled = false;
  const resNoSession = {
    status(code) { statusCode = code; return this; },
    json(body) { jsonBody = body; return this; }
  };
  requireAuth({ session: null, headers: {} }, resNoSession, () => { nextCalled = true; });
  assert.strictEqual(statusCode, 401, 'Sin sesión: requireAuth debe responder 401');
  assert.ok(jsonBody && jsonBody.error, 'Sin sesión: requireAuth debe devolver un cuerpo de error');
  assert.strictEqual(nextCalled, false, 'Sin sesión: requireAuth NO debe llamar a next()');

  // Caso: sesión sin adminId (usuario normal logueado, no admin) -> también debe rechazar.
  statusCode = null; jsonBody = null; nextCalled = false;
  requireAuth({ session: {}, headers: {} }, resNoSession, () => { nextCalled = true; });
  assert.strictEqual(statusCode, 401, 'Sesión sin adminId: requireAuth debe responder 401');
  assert.strictEqual(nextCalled, false, 'Sesión sin adminId: requireAuth NO debe llamar a next()');

  // Caso: con sesión de admin válida -> debe continuar sin tocar la respuesta.
  let statusCalledWithSession = false;
  const resWithSession = {
    status() { statusCalledWithSession = true; return this; },
    json() { return this; }
  };
  nextCalled = false;
  requireAuth({ session: { adminId: 42 }, headers: {} }, resWithSession, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true, 'Con sesión de admin: requireAuth debe llamar a next()');
  assert.strictEqual(statusCalledWithSession, false, 'Con sesión de admin: requireAuth no debe responder con error');
}

function main() {
  const checked = checkRouteWiring();
  checkRequireAuthBehavior();
  console.log(`OK: ${checked} rutas de productos/variantes auditadas — mutaciones protegidas con requireAuth+CSRF, lecturas públicas intactas.`);
}

main();
