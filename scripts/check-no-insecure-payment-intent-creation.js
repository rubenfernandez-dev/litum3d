/*
  LITUM3D - Test de regresión de seguridad (P0E-B4B, sección 41).

  Garantiza que NINGÚN stripe.paymentIntents.create() en el código activo
  (routes/, services/) deriva `amount` de datos económicos del cliente:
  req.body.amount, cart item.price, calculateCartTotals(cart) o un total
  enviado por el cliente. Debe fallar si alguien reintroduce ese patrón
  (p.ej. resucitando /api/pay o un endpoint parecido).

  Complementa (no sustituye) los tests de servicio/ruta ya existentes
  (check-checkout-payment.js, check-checkout-routes.js): aquellos prueban
  comportamiento; este prueba, por análisis estático de TODO el árbol activo,
  que no existe una segunda vía de creación de PaymentIntent además de la
  canónica.

  Uso: node scripts/check-no-insecure-payment-intent-creation.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['routes', 'services'];

const FORBIDDEN_AMOUNT_PATTERNS = [
  /req\.body/i,
  /\bitem\.price\b/i,
  /calculateCartTotals/i,
  /\bcart\[/i,
  /\bbody\.amount\b/i,
  /\bbody\.total\b/i
];

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); checks++; }

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function findPaymentIntentCreateCalls(src) {
  const marker = 'paymentIntents.create(';
  const results = [];
  let idx = src.indexOf(marker);
  while (idx !== -1) {
    results.push(src.slice(idx, idx + 400));
    idx = src.indexOf(marker, idx + marker.length);
  }
  return results;
}

function main() {
  const files = SCAN_DIRS.flatMap(d => listJsFiles(path.join(ROOT, d)));
  ok(files.length > 5, 'se han encontrado archivos .js en routes/ y services/ (sanity check del propio scanner)');

  let totalCreateCalls = 0;
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const src = fs.readFileSync(file, 'utf8');
    const calls = findPaymentIntentCreateCalls(src);
    totalCreateCalls += calls.length;

    for (const [i, block] of calls.entries()) {
      const amountMatch = block.match(/amount:\s*([^\n,]+)/);
      ok(!!amountMatch, `${rel}: llamada #${i + 1} a paymentIntents.create() debe fijar "amount:" explícitamente`);
      if (amountMatch) {
        const amountExpr = amountMatch[1];
        for (const forbidden of FORBIDDEN_AMOUNT_PATTERNS) {
          ok(
            !forbidden.test(amountExpr),
            `${rel}: amount ("${amountExpr.trim()}") NO debe derivar de un patrón inseguro (${forbidden}) -- el cliente nunca decide cuánto se cobra`
          );
        }
        ok(
          /Cents\b/.test(amountExpr),
          `${rel}: amount ("${amountExpr.trim()}") debe venir de un valor en cents calculado server-side (convención *Cents de services/pricing.js), no de un literal ni de un cálculo ad-hoc`
        );
      }
    }
  }

  // Tras el cutover, la ÚNICA vía autorizada de crear un PaymentIntent es
  // services/checkout-payment.js#ensurePaymentIntentForDraft. Si este número
  // sube, algo ha añadido una segunda vía de creación -- hay que revisarla
  // con los mismos criterios de arriba, no simplemente permitirla.
  eq(totalCreateCalls, 1, 'debe existir EXACTAMENTE 1 llamada a stripe.paymentIntents.create() en todo routes/+services/ (services/checkout-payment.js)');

  // --- Código muerto legacy: no debe quedar ninguna vía alternativa ---
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const src = fs.readFileSync(file, 'utf8');
    ok(!/function\s+calculateCartTotals/.test(src), `${rel}: calculateCartTotals (basado en item.price del cliente) no debe existir`);
    ok(!/function\s+createOrderFromCart/.test(src), `${rel}: createOrderFromCart (creaba pedidos fuera de finalizePaidCheckout) no debe existir`);
  }

  // --- /api/pay no debe estar registrada ---
  const paymentsSrc = fs.readFileSync(path.join(ROOT, 'routes', 'payments.js'), 'utf8');
  ok(!/router\.(post|get|put|patch)\(\s*['"]\/pay['"]/.test(paymentsSrc), 'routes/payments.js no debe registrar /pay (cero consumidores, creaba PaymentIntent con cifras del cliente)');

  console.log(`OK: ${checks} comprobaciones sobre ausencia de rutas inseguras de creación de PaymentIntent.`);
}

main();
