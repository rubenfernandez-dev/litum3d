// Stripe Checkout (Payment Element) - flujo canónico seguro (P0E-B4B).
//
// A partir de este cutover, NINGÚN precio mostrado o cobrado proviene de
// localStorage/item.price: el checkout se prepara contra el servidor
// (/api/create-payment-intent), que devuelve un breakdown AUTORITATIVO
// (currency/totals/items) calculado con priceCartFromSelections(). Ese
// breakdown es la única fuente de verdad para lo que se muestra Y para lo
// que Stripe cobra. cart.js sigue guardando price/basePrice/priceDelta en
// localStorage solo para las páginas de carrito (compatibilidad de display),
// pero checkout.js nunca envía esos campos al servidor.
//
// SECOND_UNIT_DISCOUNT_RATE viene declarada por cart.js, cargado antes en checkout.html/-fr/-de
let stripe;
let elements;
let paymentElement;
let clientSecret = null;
let paymentIntentId = null;
let currentBreakdown = null; // último breakdown server-side recibido
let currentAttempt = null; // { idempotencyKey, accessToken, selectionsSignature }
let currentSelections = null;
let preparing = false;
let autoRetriedAfterCanceled = false; // evita bucle si un draft nuevo también sale canceled

const CURRENCY = { code: 'eur', symbol: '€' };
const CHECKOUT_ATTEMPT_KEY = 'litum3d_checkout_attempt_v1';

function getLang() {
  return document.documentElement.lang || 'es';
}

function getCheckoutPath() {
  const lang = getLang();
  if (lang === 'de') return '/checkout-de';
  if (lang === 'fr') return '/checkout-fr';
  return '/checkout';
}

function getSuccessPath() {
  const lang = getLang();
  if (lang === 'de') return '/success-de';
  if (lang === 'fr') return '/success-fr';
  return '/success';
}

function getCartPath() {
  const lang = getLang();
  if (lang === 'de') return '/cart-de';
  if (lang === 'fr') return '/cart-fr';
  return '/cart';
}

// --- Formato EUR (sección 15) --------------------------------------------------

function formatCurrency(cents, currencyCode) {
  const amount = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency: (currencyCode || 'eur').toUpperCase() }).format(amount);
  } catch (e) {
    return `${amount.toFixed(2)} ${CURRENCY.symbol}`;
  }
}

// --- Serializador canónico (sección 7/8) ---------------------------------------

// Regla definitiva (P0E-B4B, sección 4): un item de carrito solo puede
// pagarse mediante checkout canónico si lleva selectionSchemaVersion===1,
// la marca que addToCart() (cart.js) graba explícitamente en todo item
// creado por el código actual.
//
// Cualquier item sin esa marca es legacy/no verificable, INCLUSO si ya
// tiene variantOptionIds:[] -- ese array puede haberlo añadido después
// cart-page.js#normalizeCart a un carrito pre-B2 para no romper la UI, sin
// que eso implique ninguna selección real. No importa cuánta información
// "parezca" reconstruible (priceDelta, nombres, modelName, price,
// basePrice, baseId, shapeId, extrasTotal): nunca se infiere una
// personalización perdida a partir de esos campos.
function isAmbiguousLegacyItem(item) {
  if (!item || typeof item !== 'object') return true;
  if (item.selectionSchemaVersion !== 1) return true;
  if (!Array.isArray(item.variantOptionIds)) return true;
  const numericId = Number(item.id);
  if (!Number.isFinite(numericId) || !Number.isInteger(numericId) || numericId <= 0) return true;
  return false;
}

// Produce EXCLUSIVAMENTE el contrato canónico de selecciones (ver
// services/pricing.js#ALLOWED_ITEM_KEYS): productId, quantity, modelId,
// variantOptionIds, extras{upscale,qr,adapter,qrMessage}, images, notes.
// Nunca incluye price/basePrice/priceDelta/extrasTotal/currency/subtotal/
// total/discount/tax, aunque sigan existiendo en el item de localStorage.
// Tampoco incluye selectionSchemaVersion: es solo una garantía de
// provenance del frontend (ver isAmbiguousLegacyItem arriba), no forma
// parte del contrato server-side.
function buildCanonicalSelectionsFromCart(cart) {
  const selections = [];
  const ambiguousItems = [];
  for (const item of (Array.isArray(cart) ? cart : [])) {
    if (isAmbiguousLegacyItem(item)) {
      ambiguousItems.push(item);
      continue;
    }
    const rawExtras = item.extras || {};
    const qr = !!rawExtras.qr;
    selections.push({
      productId: Number(item.id),
      quantity: parseInt(item.quantity || 1, 10),
      modelId: item.modelId ? Number(item.modelId) : null,
      variantOptionIds: normalizeVariantOptionIds(item.variantOptionIds || []),
      extras: {
        upscale: !!rawExtras.upscale,
        qr,
        adapter: !!rawExtras.adapter,
        qrMessage: qr ? String(rawExtras.qrMessage || '') : ''
      },
      images: Array.isArray(item.images) ? item.images : [],
      notes: typeof item.notes === 'string' ? item.notes : ''
    });
  }
  return { selections, ambiguousItems };
}

// --- Firma determinista de selecciones (sección 11) -----------------------------
// Solo decide si REUTILIZAR las credenciales del mismo intento (idempotencyKey/
// accessToken); la seguridad económica real sigue siendo el fingerprint
// server-side (services/checkout-drafts.js#computeSelectionsFingerprint). No
// necesita ser criptográficamente segura, solo determinista.
function computeSelectionsSignature(selections) {
  const canonical = selections.map(item => ({
    productId: item.productId,
    quantity: item.quantity,
    modelId: item.modelId,
    variantOptionIds: [...item.variantOptionIds].sort((a, b) => a - b),
    extras: {
      upscale: item.extras.upscale,
      qr: item.extras.qr,
      adapter: item.extras.adapter,
      qrMessage: item.extras.qrMessage
    },
    images: item.images,
    notes: item.notes
  }));
  return JSON.stringify(canonical);
}

// --- CSPRNG (sección 9) ---------------------------------------------------------
// 32 bytes -> 64 caracteres hex minúscula (mismo contrato que
// services/checkout-drafts.js#ACCESS_TOKEN_FORMAT_REGEX). Nunca Math.random(),
// Date.now() ni un ID secuencial.
function generateSecureToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- Checkout attempt en sessionStorage (secciones 10/12) -----------------------
// Sobrevive timeout/error de red/retry/refresh/redirect Stripe-3DS. NUNCA
// guarda customerData, datos de tarjeta, ni precios como autoridad -- solo
// las dos credenciales y una firma de las selecciones actuales.
function loadStoredAttempt() {
  try {
    const raw = sessionStorage.getItem(CHECKOUT_ATTEMPT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function saveAttempt(attempt) {
  try {
    sessionStorage.setItem(CHECKOUT_ATTEMPT_KEY, JSON.stringify(attempt));
  } catch (e) {
    // ignore (modo privado / cuota agotada): el intento seguirá funcionando
    // dentro de esta misma carga de página, solo no sobrevivirá a un refresh.
  }
}

function clearStoredAttempt() {
  try {
    sessionStorage.removeItem(CHECKOUT_ATTEMPT_KEY);
  } catch (e) {
    // ignore
  }
}

// Reutiliza el intento guardado SOLO si las selecciones actuales coinciden
// exactamente con las que se usaron para crearlo. Si cambian (añadir/quitar
// artículo, cambiar variante...), genera credenciales nuevas -- el mismo
// idempotencyKey nunca se reutiliza para selecciones distintas.
function getOrCreateCheckoutAttempt(selections) {
  const signature = computeSelectionsSignature(selections);
  const stored = loadStoredAttempt();
  if (stored && stored.idempotencyKey && stored.accessToken && stored.selectionsSignature === signature) {
    return stored;
  }
  const attempt = { idempotencyKey: generateSecureToken(), accessToken: generateSecureToken(), selectionsSignature: signature };
  saveAttempt(attempt);
  return attempt;
}

// --- Inicialización -------------------------------------------------------------

async function initializeCheckout() {
  await initializeStripe();
  document.getElementById('checkout-form').addEventListener('submit', handleCheckout);
  await prepareCheckout();
}

async function initializeStripe() {
  const statusDiv = document.getElementById('payment-status');
  try {
    const response = await fetch('/api/stripe-config');
    const result = await response.json();
    if (!result.ok || !result.publicKey) {
      throw new Error('Stripe no configurado');
    }
    stripe = Stripe(result.publicKey);
  } catch (err) {
    console.error('Stripe init error:', err);
    if (statusDiv) {
      statusDiv.className = 'status error';
      statusDiv.textContent = `✗ ${err.message}`;
    }
  }
}

function setPayButtonEnabled(enabled) {
  const btn = document.querySelector('#checkout-form button[type="submit"]');
  if (btn) btn.disabled = !enabled;
}

function showLoadingSummary() {
  const summary = document.getElementById('order-summary');
  if (summary) summary.innerHTML = `<p style="opacity:0.7;">Calculando el precio con el servidor…</p>`;
}

function showAmbiguousCartMessage(ambiguousItems) {
  const summary = document.getElementById('order-summary');
  const names = ambiguousItems.map(i => (i && i.name) || 'Artículo').join(', ');
  if (summary) {
    summary.innerHTML = `
      <div class="status error" style="padding:1rem; border-radius:8px;">
        <p style="margin:0 0 8px 0;"><strong>Este artículo fue configurado con una versión anterior del carrito. Para garantizar que su personalización y precio sean correctos, vuelve a configurarlo antes de pagar.</strong></p>
        <p style="margin:0 0 8px 0; opacity:0.85;">${escapeHtml(names)}</p>
        <p style="margin:0;">Tu carrito NO se ha modificado.</p>
        <a href="${getCartPath()}" style="display:inline-block; margin-top:10px; color:var(--gold);">Ir al carrito</a>
      </div>
    `;
  }
  setPayButtonEnabled(false);
}

function showPrepareError(message, { retryable = true } = {}) {
  const summary = document.getElementById('order-summary');
  if (summary) {
    summary.innerHTML = `
      <div class="status error" style="padding:1rem; border-radius:8px;">
        <p style="margin:0 0 8px 0;">✗ ${escapeHtml(message)}</p>
        ${retryable ? `<button type="button" id="retry-prepare-btn" class="btn-secondary" style="padding:8px 16px;">Reintentar</button>` : ''}
      </div>
    `;
    const retryBtn = document.getElementById('retry-prepare-btn');
    if (retryBtn) retryBtn.addEventListener('click', () => prepareCheckout());
  }
  setPayButtonEnabled(false);
}

// --- Preparar checkout (secciones 13/14) ----------------------------------------

async function prepareCheckout() {
  if (preparing) return;
  preparing = true;
  setPayButtonEnabled(false);

  try {
    const cart = getCart();
    if (cart.length === 0) {
      window.location.href = getCartPath();
      return;
    }

    const { selections, ambiguousItems } = buildCanonicalSelectionsFromCart(cart);

    if (ambiguousItems.length > 0) {
      showAmbiguousCartMessage(ambiguousItems);
      return;
    }
    if (selections.length === 0) {
      showPrepareError('Tu carrito está vacío o no contiene artículos válidos.', { retryable: false });
      return;
    }

    showLoadingSummary();
    currentSelections = selections;
    currentAttempt = getOrCreateCheckoutAttempt(selections);

    const response = await fetch('/api/create-payment-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: currentAttempt.idempotencyKey,
        accessToken: currentAttempt.accessToken,
        selections
      })
    });

    const result = await response.json();
    if (!response.ok || !result.ok) {
      // Timeout/5xx/red: NO se genera un intento nuevo. El siguiente
      // "Reintentar" (o una nueva llamada a prepareCheckout) reutiliza el
      // MISMO idempotencyKey/accessToken/selections vía getOrCreateCheckoutAttempt.
      showPrepareError(result.error || 'No se pudo iniciar el pago. Intenta de nuevo.');
      return;
    }

    currentBreakdown = result;
    clientSecret = result.clientSecret;
    paymentIntentId = result.paymentIntentId;

    if (result.paymentIntentStatus === 'canceled') {
      // Sección 28: el PI de este draft ya no es usable. Nunca se monta un
      // Payment Element sobre un PI canceled ni se reintenta silenciosamente
      // sobre el MISMO draft. Se invalida el intento local y se empieza uno
      // nuevo -- solo una vez, para no entrar en bucle si el nuevo draft
      // también sale canceled por alguna razón ajena.
      clearStoredAttempt();
      currentAttempt = null;
      if (!autoRetriedAfterCanceled) {
        autoRetriedAfterCanceled = true;
        // preparing se libera ANTES de la llamada recursiva: si no, el guard
        // de reentrancia del inicio de prepareCheckout() (preparing===true,
        // seguimos dentro de la llamada externa) bloquearía este reintento.
        preparing = false;
        await prepareCheckout();
        return;
      }
      showPrepareError('El intento de pago anterior ya no es válido. Recarga la página para empezar de nuevo.', { retryable: false });
      return;
    }

    renderOrderSummaryFromBreakdown(currentBreakdown, cart);

    if (result.paymentIntentStatus === 'succeeded') {
      // Sección 29: Stripe ya cobró en un intento anterior (el navegador
      // perdió la respuesta antes de llegar a confirm-payment). NO se monta
      // Payment Element para cobrar otra vez: se reconcilia directamente.
      const statusDiv = document.getElementById('payment-status');
      if (statusDiv) {
        statusDiv.className = 'status';
        statusDiv.textContent = 'Tu pago ya se completó. Confirmando pedido…';
      }
      await reconcilePayment(paymentIntentId);
      return;
    }

    if (result.paymentIntentStatus === 'processing') {
      const statusDiv = document.getElementById('payment-status');
      if (statusDiv) {
        statusDiv.className = 'status';
        statusDiv.textContent = 'Tu pago anterior sigue procesándose. Espera unos segundos y recarga esta página.';
      }
      setPayButtonEnabled(false);
      return;
    }

    await mountPaymentElement(clientSecret);
    setPayButtonEnabled(true);
  } catch (err) {
    console.error('prepareCheckout error:', err);
    showPrepareError(err.message || 'No se pudo iniciar el pago. Intenta de nuevo.');
  } finally {
    preparing = false;
  }
}

async function mountPaymentElement(secret) {
  if (paymentElement) {
    try { paymentElement.unmount(); } catch (e) { /* ignore */ }
  }
  const order = ['paypal', 'twint', 'amazon_pay', 'card'];
  elements = stripe.elements({ clientSecret: secret });
  paymentElement = elements.create('payment', {
    layout: { type: 'accordion', defaultCollapsed: false, radios: true, spacedAccordionItems: true },
    paymentMethodOrder: order
  });
  paymentElement.mount('#payment-element');
}

// --- Resumen autoritativo server-side (sección 14) ------------------------------
// A partir de aquí, currentBreakdown (currency/totals/items del servidor) es
// la ÚNICA fuente para lo que se muestra. item.price/calculateCartTotals
// local ya NO se usan como autoridad -- el cart local solo aporta notas e
// imágenes para el display (no económicas), emparejado por índice: ambos
// arrays derivan de la MISMA lista de selections en el MISMO orden.
function renderOrderSummaryFromBreakdown(breakdown, cart) {
  const summary = document.getElementById('order-summary');
  if (!summary) return;
  const currency = breakdown.currency;

  const rows = breakdown.items.map((item, idx) => {
    const localItem = cart[idx] || {};
    const extrasParts = [];
    if (item.extras?.upscale) extrasParts.push('Upscale');
    if (item.extras?.qr) extrasParts.push(`QR${item.extras.qrMessage ? `: ${escapeHtml(item.extras.qrMessage)}` : ''}`);
    if (item.extras?.adapter) extrasParts.push('Adaptador USB');
    const variantsText = (item.variantSelections || []).map(v => v.optionName).join(', ');

    return `
      <div class="cart-summary-row">
        <span>
          ${escapeHtml(item.productName)}${item.modelName ? ' · ' + escapeHtml(item.modelName) : ''}
          ${variantsText ? `<br><small style="opacity:0.8;">${escapeHtml(variantsText)}</small>` : ''}
          ${localItem.notes ? `<br><small style="opacity:0.8;">Notas: ${escapeHtml(localItem.notes)}</small>` : ''}
          ${extrasParts.length ? `<br><small style="opacity:0.8;">Extras: ${extrasParts.join(' · ')}</small>` : ''}
        </span>
        <span>${formatCurrency(item.unitPriceCents * item.quantity, currency)}</span>
      </div>
    `;
  }).join('');

  const t = breakdown.totals;
  summary.innerHTML = `
    ${rows}
    <div class="cart-summary-row">
      <span>Base (sin IVA):</span>
      <span>${formatCurrency(t.netCents, currency)}</span>
    </div>
    <div class="cart-summary-row">
      <span>Envío:</span>
      <span style="color: #90ee90;">${t.shippingCents > 0 ? formatCurrency(t.shippingCents, currency) : 'Gratis'}</span>
    </div>
    <div class="cart-summary-row">
      <span>IVA:</span>
      <span>${formatCurrency(t.taxCents, currency)}</span>
    </div>
    ${t.discountCents > 0 ? `
    <div class="cart-summary-row">
      <span>Descuento 2ª unidad:</span>
      <span style="color: #90ee90;">-${formatCurrency(t.discountCents, currency)}</span>
    </div>
    ` : ''}
    <div class="cart-summary-row total">
      <span>TOTAL:</span>
      <span>${formatCurrency(t.totalCents, currency)}</span>
    </div>
  `;

  document.getElementById('total-amount') && (document.getElementById('total-amount').textContent = (t.totalCents / 100).toFixed(2));
  const symbolEl = document.getElementById('currency-symbol');
  if (symbolEl) symbolEl.textContent = CURRENCY.symbol + ' ';
  updatePayButtonLabel(t.totalCents, currency);
  if (document.getElementById('cart-badge')) {
    document.getElementById('cart-badge').textContent = getCartCount();
  }
}

function updatePayButtonLabel(totalCents, currency) {
  const btn = document.querySelector('#checkout-form button[type="submit"]');
  if (!btn) return;
  btn.textContent = `Pagar ${formatCurrency(totalCents, currency)}`;
}

// --- Click en pagar: orden estricto (sección 16) --------------------------------

async function handleCheckout(e) {
  e.preventDefault();

  const form = document.getElementById('checkout-form');
  const statusDiv = document.getElementById('payment-status');
  const submitBtn = form.querySelector('button[type="submit"]');

  if (!currentBreakdown || !clientSecret || !currentAttempt) {
    statusDiv.className = 'status error';
    statusDiv.textContent = '✗ El checkout todavía no está listo. Espera un momento e inténtalo de nuevo.';
    return;
  }

  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  // country NUNCA se envía al draft: B3/B4A no lo admite en customerData (es
  // server-controlled, ver services/checkout-finalization.js#CHECKOUT_COUNTRY_CODE).
  const { country, ...customerDataForDraft } = getCustomerData(form);

  submitBtn.disabled = true;
  submitBtn.textContent = 'Procesando...';
  statusDiv.textContent = '';

  try {
    if (!stripe || !elements) {
      throw new Error('No se pudo inicializar el método de pago. Recarga la página.');
    }

    // 1) PATCH customer-data. 2) SOLO si responde OK, stripe.confirmPayment().
    const patchResponse = await fetch('/api/checkout-draft/customer-data', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: currentAttempt.accessToken, customerData: customerDataForDraft })
    });
    const patchResult = await patchResponse.json();
    if (!patchResponse.ok || !patchResult.ok) {
      throw new Error(patchResult.error || 'No se pudieron guardar tus datos. Revisa el formulario e inténtalo de nuevo.');
    }

    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}${getSuccessPath()}`
      },
      redirect: 'if_required'
    });

    if (error) {
      throw new Error(error.message);
    }

    if (paymentIntent && paymentIntent.status === 'succeeded') {
      await reconcilePayment(paymentIntent.id);
      return;
    }

    if (paymentIntent && paymentIntent.status === 'processing') {
      statusDiv.className = 'status success';
      statusDiv.textContent = 'Pago en proceso. Te avisaremos por email en cuanto se confirme.';
      return;
    }
  } catch (err) {
    console.error('Checkout error:', err);
    statusDiv.className = 'status error';
    statusDiv.textContent = `✗ ${err.message}`;
    submitBtn.disabled = false;
    if (currentBreakdown) {
      updatePayButtonLabel(currentBreakdown.totals.totalCents, currentBreakdown.currency);
    } else {
      submitBtn.textContent = 'Pagar';
    }
  }
}

function getCustomerData(form) {
  return {
    name: form?.customer_name?.value || '',
    email: form?.customer_email?.value || '',
    phone: form?.customer_phone?.value || '',
    address: form?.customer_address?.value || '',
    city: form?.customer_city?.value || '',
    zip: form?.customer_zip?.value || '',
    country: 'CH'
  };
}

// --- Reconciliación (secciones 5/18/31) -----------------------------------------
// Llama a POST /api/confirm-payment y, si el backend confirma ok:true,
// redirige a success con ?payment_intent=<piId> (NUNCA ?orderId=, ver
// public/js/success.js) -- success.js volverá a llamar a
// /api/confirm-payment con ese mismo id. Es intencional: finalizePaidCheckout
// es idempotente (created:false + mismo orderId + sin segundo email en la
// segunda llamada), así que este doble paso hace que el pago sin redirect
// (este flujo) y el pago con 3DS/redirect (que llega a success sin pasar
// por aquí) terminen reconciliándose por el MISMO mecanismo.
//
// Cleanup (hardening final, sección 1): en CUANTO el backend confirma
// ok:true -- nunca antes, ni solo porque Stripe devolvió succeeded -- se
// limpia cart/checkout attempt AQUÍ, antes de navegar a success. Si no se
// hiciera aquí y el usuario cerrara la pestaña entre este punto y el
// redirect a success, el pedido ya estaría pagado/creado pero
// litum3d_cart seguiría en localStorage: una sesión futura con ese mismo
// carrito podría reiniciar un checkout completo por algo ya pagado. Que
// success.js TAMBIÉN limpie tras su propia respuesta ok:true no es un
// problema: ambas limpiezas son idempotentes (clearCart sobre carrito ya
// vacío, removeItem sobre clave ya inexistente), y success.js sigue siendo
// necesario como cierre para el flujo con redirect 3DS, que nunca pasa por
// esta función.
async function reconcilePayment(piId) {
  const statusDiv = document.getElementById('payment-status');
  try {
    const response = await fetch('/api/confirm-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentIntentId: piId })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      // NO se limpia nada: el backend no ha confirmado nada todavía. Un
      // retry posterior (mismo PI, mismo intento) debe seguir siendo posible.
      throw new Error(result.error || 'No se pudo confirmar el pago');
    }

    if (statusDiv) {
      statusDiv.className = 'status success';
      statusDiv.innerHTML = `
        <strong>✓ Pago realizado con éxito!</strong><br>
        <small>Confirmando tu pedido...</small>
      `;
    }

    clearCart();
    clearStoredAttempt();

    window.location.href = `${getSuccessPath()}?payment_intent=${encodeURIComponent(piId)}`;
  } catch (err) {
    console.error('Reconcile payment error:', err);
    if (statusDiv) {
      statusDiv.className = 'status error';
      statusDiv.textContent = `✗ ${err.message}`;
    }
  }
}

function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return String(text || '').replace(/[&<>"']/g, m => map[m]);
}

document.addEventListener('DOMContentLoaded', () => {
  initializeCheckout();
});
