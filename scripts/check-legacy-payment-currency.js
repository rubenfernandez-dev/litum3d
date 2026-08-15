/*
  LITUM3D - Test de regresión (EUR-ONLY-01, sección 21).

  B4B (services/checkout-payment.js + services/checkout-finalization.js)
  todavía NO está conectado a ninguna ruta pública: el checkout público real
  sigue siendo routes/payments.js (/api/pay, /api/create-payment-intent,
  /api/confirm-payment). Este test comprueba, por análisis estático del
  código fuente (SIN llamadas Stripe reales, sin servidor levantado), que
  ese flujo legacy:

    1. no contiene 'chf'/"chf" como autoridad económica activa en ningún
       sitio (ni como currency de Stripe, ni como fallback/comparación);
    2. SÍ deriva la moneda de cada stripe.paymentIntents.create() y de cada
       comparación de moneda esperada desde pricingConfig.currency
       (config/pricing.js), nunca de un literal hardcodeado ni del body
       de la request.

  Uso: node scripts/check-legacy-payment-currency.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PAYMENTS_ROUTE_PATH = path.join(__dirname, '..', 'routes', 'payments.js');

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }

function main() {
  const src = fs.readFileSync(PAYMENTS_ROUTE_PATH, 'utf8');

  // 1. Ninguna autoridad económica activa en 'chf'/"chf" (case-insensitive:
  // Stripe exige minúscula, pero se comprueba también la variante en
  // mayúscula por si alguien la reintroduce mal).
  ok(
    !/['"]chf['"]/i.test(src),
    'routes/payments.js no debe contener el literal \'chf\'/"chf" en ningún sitio (EUR-ONLY-01)'
  );

  // 2. Las 3 rutas de cobro (/pay, /create-payment-intent, /confirm-payment)
  // y el endpoint informativo /pricing-config derivan la moneda de
  // pricingConfig.currency -- se exige un mínimo de apariciones que solo se
  // cumple si las 3 rutas + /pricing-config siguen usando la fuente server-side
  // (si alguien volviera a hardcodear una ruta, este conteo bajaría).
  const pricingConfigCurrencyMatches = src.match(/pricingConfig\.currency/g) || [];
  ok(
    pricingConfigCurrencyMatches.length >= 7,
    `routes/payments.js debe derivar la moneda de pricingConfig.currency en /pricing-config, /pay, /create-payment-intent y /confirm-payment (encontradas ${pricingConfigCurrencyMatches.length} referencias, se esperaban >= 7)`
  );

  // 3. Cada stripe.paymentIntents.create() debe fijar currency desde la
  // fuente server-side, nunca un literal.
  const createBlocks = src.split('stripe.paymentIntents.create(').slice(1);
  ok(createBlocks.length >= 2, 'routes/payments.js debe seguir teniendo al menos 2 llamadas a stripe.paymentIntents.create (/pay y /create-payment-intent)');
  for (const block of createBlocks) {
    const nearby = block.slice(0, 400); // ventana razonable tras el `(` de la llamada
    ok(
      /currency:\s*(pricingConfig\.currency|currencyCode)\b/.test(nearby),
      'cada stripe.paymentIntents.create() debe fijar currency desde pricingConfig.currency (directo o vía la variable local currencyCode), nunca un literal'
    );
  }

  // 4. El body del cliente puede incluir un campo `currency`, pero debe
  // quedar explícitamente ignorado (nunca usado para decidir la moneda real).
  ok(
    /currency:\s*_clientProvidedCurrencyIgnored/.test(src),
    '/pay debe destructurar `currency` del body solo para documentar que se ignora explícitamente, no para usarlo'
  );

  // 5b. Hardening final EUR-ONLY-01 (sección 1/8): el bloque FX EUR->CHF
  // (código muerto, sin consumidores) debe haberse eliminado por completo,
  // no solo quedar documentado como "no usado".
  ok(!/getEurToChfRate/.test(src), 'getEurToChfRate no debe existir: LITUM3D no realiza conversión de moneda');
  ok(!/eur-chf/i.test(src), 'el endpoint GET /fx/eur-chf no debe existir');
  ok(!/eurChfCache/.test(src), 'la caché de tasa FX (eurChfCache) no debe existir');
  ok(!/EXCHANGE_EUR_CHF|FX_CACHE_TTL_MS/.test(src), 'no deben quedar referencias a las env vars FX (EXCHANGE_EUR_CHF/FX_CACHE_TTL_MS)');

  // 5. createOrderFromCart (sección 13/23 del ticket EUR-ONLY-01) debe
  // persistir pedidos.currency, derivado de selectedCurrency (que a su vez
  // viene siempre de pricingConfig.currency en las 3 rutas, nunca del
  // cliente) -- ver comprobación #2 más arriba. Nota: createOrderFromCart no
  // es fácilmente testeable de forma aislada (usa config/db.pool
  // directamente, sin inyección) y refactorizarlo está fuera de alcance de
  // este ticket (B4B la sustituirá); esta es una comprobación estática del
  // INSERT, no un test de integración end-to-end.
  const insertPedidosMatch = src.match(/INSERT INTO pedidos \(([^)]*)\)[^;]*?\[([\s\S]*?)\]\s*\)/);
  ok(!!insertPedidosMatch, 'createOrderFromCart debe tener un INSERT INTO pedidos reconocible');
  if (insertPedidosMatch) {
    const columns = insertPedidosMatch[1];
    const values = insertPedidosMatch[2];
    ok(/\bcurrency\b/.test(columns), 'el INSERT INTO pedidos legacy debe incluir la columna currency');
    ok(
      /selectedCurrency\.toUpperCase\(\)/.test(values),
      'el valor de currency en el INSERT debe derivarse de selectedCurrency.toUpperCase() (server-side), no de un literal ni del body del cliente'
    );
  }

  console.log(`OK: ${checks} comprobaciones sobre la moneda del flujo de pago legacy (routes/payments.js).`);
}

main();
