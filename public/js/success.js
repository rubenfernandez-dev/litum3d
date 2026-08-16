// LITUM3D - Página de éxito / reconciliación de checkout (P0E-B4B, secciones 7-11).
//
// ÚNICA forma legítima de mostrar un pedido confirmado aquí: la URL trae
// ?payment_intent=pi_... (lo añade Stripe tras el redirect 3DS, o lo añade
// nuestro propio checkout.js al redirigir tras confirmar). Esta página:
//   a) extrae ÚNICAMENTE payment_intent de la URL (nunca amount/currency/
//      orderId/payment_intent_client_secret/redirect_status);
//   b) llama a POST /api/confirm-payment con ese id;
//   c) el backend hace stripe.paymentIntents.retrieve + finalizePaidCheckout;
//   d) solo se muestra "confirmado" tras una respuesta ok:true del backend,
//      con el orderId que el backend devuelve -- nunca uno leído de la URL.
//
// ?orderId=N en la URL NUNCA es, por sí solo, evidencia de un pedido
// confirmado (es un query string controlado por el navegador): sin
// payment_intent, esta página NO afirma éxito, tenga o no orderId.
//
// finalizePaidCheckout es idempotente: si checkout.js ya confirmó este
// mismo paymentIntentId antes de redirigir aquí (flujo sin redirect,
// checkout.js#reconcilePayment), esta segunda llamada devuelve
// created:false y el MISMO orderId, sin segundo email. checkout.js YA
// limpió cart/checkout attempt en ese caso, en cuanto obtuvo su propio
// ok:true (hardening final, sección 1: nunca dejar un carrito ya pagado
// residual en localStorage a la espera de este redirect). Esta página
// limpia OTRA VEZ tras SU propia respuesta ok:true -- necesario para el
// flujo con redirect 3DS, que nunca pasa por checkout.js#reconcilePayment.
// Ambas limpiezas son idempotentes (clearCart sobre carrito ya vacío,
// removeItem sobre clave ya inexistente): que se ejecuten dos veces no es
// un problema.
//
// pendingOrder/localStorage NUNCA se usan para construir ni mostrar el
// pedido: toda la información viene del backend o de la propia URL.

const SUCCESS_LABELS = {
  es: {
    orderPrefix: 'Pedido #',
    confirming: 'Confirmando tu pago…',
    errorGeneric: 'No pudimos confirmar tu pago.',
    retry: 'Reintentar',
    noContext: 'No se ha podido verificar un pago para esta página.',
    goHome: 'Volver al inicio'
  },
  de: {
    orderPrefix: 'Bestellung #',
    confirming: 'Zahlung wird bestätigt…',
    errorGeneric: 'Wir konnten deine Zahlung nicht bestätigen.',
    retry: 'Erneut versuchen',
    noContext: 'Für diese Seite konnte keine Zahlung überprüft werden.',
    goHome: 'Zur Startseite'
  },
  fr: {
    orderPrefix: 'Commande #',
    confirming: 'Confirmation de votre paiement…',
    errorGeneric: "Nous n'avons pas pu confirmer votre paiement.",
    retry: 'Réessayer',
    noContext: "Nous n'avons pas pu vérifier de paiement pour cette page.",
    goHome: 'Retour à l’accueil'
  }
};

// Mismo contrato que checkout.js#CHECKOUT_ATTEMPT_KEY. Duplicado (no
// importado) porque success.js se sirve como script standalone, igual que
// el resto de páginas del storefront -- no hay bundler ni módulos aquí.
const CHECKOUT_ATTEMPT_KEY = 'litum3d_checkout_attempt_v1';

function clearStoredCheckoutAttempt() {
  try {
    sessionStorage.removeItem(CHECKOUT_ATTEMPT_KEY);
  } catch (e) {
    // ignore (modo privado / cuota agotada)
  }
}

function getSuccessLang() {
  const lang = document.documentElement.lang;
  return SUCCESS_LABELS[lang] ? lang : 'es';
}

function getSuccessLabels() {
  return SUCCESS_LABELS[getSuccessLang()];
}

function getHomePath() {
  const lang = getSuccessLang();
  if (lang === 'de') return '/de';
  if (lang === 'fr') return '/fr';
  return '/';
}

function showOrderNumber(orderId) {
  const labels = getSuccessLabels();
  const el = document.getElementById('order-number');
  if (el) el.textContent = `${labels.orderPrefix}${orderId}`;
}

function showReconciliationError(message) {
  const labels = getSuccessLabels();
  const el = document.getElementById('order-number');
  if (el) {
    el.textContent = message || labels.errorGeneric;
    el.style.color = '#ef4444';
  }
  const container = document.querySelector('.order-details');
  if (container) container.style.display = 'none';
  const nextSteps = document.querySelector('.next-steps');
  if (nextSteps) nextSteps.style.display = 'none';

  const actions = document.querySelector('.action-buttons');
  if (actions) {
    const retryBtn = document.createElement('a');
    retryBtn.href = window.location.pathname + window.location.search;
    retryBtn.className = 'btn-primary';
    retryBtn.textContent = labels.retry;
    actions.prepend(retryBtn);
  }
}

function showNoOrderContext() {
  const labels = getSuccessLabels();
  const el = document.getElementById('order-number');
  if (el) el.textContent = labels.noContext;
  const container = document.querySelector('.order-details');
  if (container) container.style.display = 'none';
}

async function confirmPaymentIntent(paymentIntentId) {
  const labels = getSuccessLabels();
  const el = document.getElementById('order-number');
  if (el) el.textContent = labels.confirming;

  try {
    const response = await fetch('/api/confirm-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentIntentId })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(result.error || labels.errorGeneric);
    }
    // Cierre final único (sección 11): solo tras ok:true del backend, nunca
    // antes. Cubre tanto el caso created:true (primera confirmación, si
    // checkout.js redirigió sin haber podido confirmar) como created:false
    // (checkout.js ya confirmó y esta es la reconciliación del retorno 3DS).
    clearCart();
    clearStoredCheckoutAttempt();
    showOrderNumber(result.orderId);
  } catch (err) {
    console.error('confirmPaymentIntent error:', err);
    showReconciliationError(err.message);
  }
}

function formatOrderDate() {
  const el = document.getElementById('order-date');
  if (!el) return;
  const localeByLang = { es: 'es-ES', de: 'de-DE', fr: 'fr-FR' };
  const today = new Date();
  el.textContent = today.toLocaleDateString(localeByLang[getSuccessLang()], { year: 'numeric', month: 'long', day: 'numeric' });
}

function initSuccessPage() {
  if (document.getElementById('cart-badge')) {
    document.getElementById('cart-badge').textContent = getCartCount();
  }
  formatOrderDate();

  const params = new URLSearchParams(window.location.search);
  const paymentIntentIdFromRedirect = params.get('payment_intent');

  if (paymentIntentIdFromRedirect) {
    // Único trust path: NUNCA se confía en amount/currency/orderId de la
    // URL (Stripe no los envía; payment_intent_client_secret/redirect_status,
    // si están presentes, se ignoran igual). Solo se usa el id para pedirle
    // al backend que reconcilie -- venga de un redirect de Stripe o de
    // nuestro propio checkout.js.
    confirmPaymentIntent(paymentIntentIdFromRedirect);
    return;
  }

  // Sin payment_intent (incluido ?orderId=N sin él, que un query string
  // controlado por el navegador nunca demuestra que exista un pedido
  // confirmado): no hay ninguna evidencia verificable de un pago.
  showNoOrderContext();
}

document.addEventListener('DOMContentLoaded', initSuccessPage);
