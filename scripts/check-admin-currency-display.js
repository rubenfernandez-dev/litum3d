/*
  LITUM3D - Test de regresión (EUR-ONLY-01, hardening final).

  Verifica el <script> inline de views/admin-dashboard.html TAL CUAL se sirve
  al navegador (sin reescribirlo), ejecutado en un sandbox de Node (vm
  nativo) con DOM/fetch mínimos simulados -- mismo patrón que
  scripts/check-frontend-selections.js para public/js/*.js.

  Cubre la regla de EUR-ONLY-01 sección 3/4/5: un pedido con currency=NULL
  (histórico sin moneda registrada) NUNCA debe mostrarse con símbolo €
  inventado, ni sumarse dentro del KPI "Ingresos EUR".

  Uso: node scripts/check-admin-currency-display.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function readAdminDashboardScript() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin-dashboard.html'), 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('No se encontró el <script> inline en views/admin-dashboard.html');
  return match[1];
}

function makeElementStub() {
  return {
    textContent: '', innerHTML: '', value: '', style: {},
    classList: { add() {}, remove() {} },
    addEventListener() {}
  };
}

function makeDocumentStub() {
  const registry = new Map();
  return {
    getElementById(id) {
      if (!registry.has(id)) registry.set(id, makeElementStub());
      return registry.get(id);
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
    createElement: () => makeElementStub(),
    _registry: registry
  };
}

function loadAdminSandbox() {
  const document = makeDocumentStub();
  const sandbox = {
    console,
    document,
    window: { location: {} },
    // loadOrders() se auto-invoca al final del script; se simula un fetch
    // que falla de forma controlada (igual que un admin sin sesión válida)
    // para no depender de red real ni de servidor levantado.
    fetch: async () => ({ ok: false, status: 401, json: async () => ({}) })
  };
  vm.createContext(sandbox);
  vm.runInContext(readAdminDashboardScript(), sandbox, { filename: 'admin-dashboard.inline.js' });
  return sandbox;
}

// `let orders = []` es una declaración de nivel superior: vm NO la expone
// como propiedad del objeto sandbox (a diferencia de `var`/function
// declarations), así que sandbox.orders = [...] no tocaría el binding real
// que usa updateStats(). Se ejecuta código adicional EN EL MISMO contexto
// (mismo entorno léxico) para leer/escribir `orders` y llamar updateStats().
function setOrdersAndUpdateStats(sandbox, orders) {
  vm.runInContext(
    `orders = ${JSON.stringify(orders)}; updateStats();`,
    sandbox,
    { filename: 'admin-dashboard.test-harness.js' }
  );
}

let checks = 0;
function eq(a, b, msg) { assert.strictEqual(a, b, msg); checks++; }
function ok(cond, msg) { assert.ok(cond, msg); checks++; }

function main() {
  const sandbox = loadAdminSandbox();

  // --- orderCurrencySymbol: la pieza que decide qué símbolo mostrar ---
  eq(sandbox.orderCurrencySymbol('EUR'), '€', 'currency="EUR" debe mostrar el símbolo €');
  eq(sandbox.orderCurrencySymbol(null), '', 'currency=NULL (histórico) NO debe mostrar ningún símbolo inventado');
  eq(sandbox.orderCurrencySymbol(undefined), '', 'currency=undefined tampoco debe mostrar símbolo inventado');
  eq(sandbox.orderCurrencySymbol('USD'), 'USD ', 'una moneda ISO distinta de EUR debe mostrarse tal cual, nunca traducida a €');

  // --- updateStats: Revenue EUR debe sumar EXCLUSIVAMENTE currency==='EUR' ---
  setOrdersAndUpdateStats(sandbox, [
    { total: '100.00', currency: 'EUR', estado_nombre: 'Pendiente' },
    { total: '200.00', currency: null, estado_nombre: 'Confirmado' } // histórico, sin moneda registrada
  ]);
  eq(sandbox.document.getElementById('totalOrders').textContent, 2, 'Pedidos Totales SÍ debe contar todos los pedidos (EUR + históricos NULL)');
  eq(sandbox.document.getElementById('totalRevenue').textContent, '€100.00', 'Ingresos EUR debe ser SOLO 100.00 (el pedido EUR), nunca 300.00 -- el histórico NULL no se suma ni se le asume EUR');

  // Caso extremo: si no hay ningún pedido en EUR, Ingresos EUR debe ser 0, no la suma de los históricos.
  setOrdersAndUpdateStats(sandbox, [{ total: '500.00', currency: null, estado_nombre: 'Pendiente' }]);
  eq(sandbox.document.getElementById('totalRevenue').textContent, '€0.00', 'sin ningún pedido EUR, Ingresos EUR debe ser 0.00 (no se suman históricos NULL)');

  // --- Modal de detalle: precio por línea debe reutilizar orderCurrencySymbol,
  // nunca un € hardcodeado (sección 4 del hardening). Comprobación estática
  // del propio texto fuente: el fetch de /admin/pedidos/:id/detalle no es
  // trivial de simular de extremo a extremo sin duplicar la lógica de
  // símbolos que ya se prueba arriba, así que se verifica directamente que
  // la plantilla del item usa la variable derivada del helper, y que no
  // queda ningún '€${' hardcodeado en esa función.
  const src = readAdminDashboardScript();
  const itemsMapStart = src.indexOf('data.items.map(it =>');
  ok(itemsMapStart !== -1, 'debe existir el map() que construye las líneas del pedido en el modal de detalle');
  const itemsMapEndMarker = src.indexOf("}).join('');", itemsMapStart);
  ok(itemsMapEndMarker !== -1, 'debe existir el cierre del map() (}).join(\'\');) tras el inicio encontrado');
  const itemsMapBlock = src.slice(itemsMapStart, itemsMapEndMarker);
  ok(
    /itemsCurrencySymbol/.test(itemsMapBlock) && !/€\$\{/.test(itemsMapBlock),
    'las líneas del modal de detalle deben usar itemsCurrencySymbol (derivado de orderCurrencySymbol), sin ningún € hardcodeado'
  );
  ok(
    /const itemsCurrencySymbol = orderCurrencySymbol\(data\.order\.currency\)/.test(src),
    'itemsCurrencySymbol debe derivarse de orderCurrencySymbol(data.order.currency), reutilizando el mismo helper que el resto del panel'
  );

  console.log(`OK: ${checks} comprobaciones sobre el tratamiento de currency NULL/EUR en el dashboard de admin.`);
}

main();
