// Stripe Checkout (Payment Element) - CHF Only
const SECOND_UNIT_DISCOUNT_RATE = 0.15;
let stripe;
let elements;
let paymentElement;
let clientSecret = null;
let paymentIntentId = null;
const CURRENCY = { code: 'chf', symbol: 'CHF' };

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

async function initializeCheckout() {
  await initializeStripe();
  // Render order summary
  renderOrderSummary();
  updateTotalAmount();

  // Form submission
  document.getElementById('checkout-form').addEventListener('submit', handleCheckout);

  const initPayment = async () => {
    const handled = await handleReturnFromRedirect();
    if (!handled) {
      await setupPaymentElement();
    }
  };

  initPayment();
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

function renderOrderSummary() {
  const cart = getCart();
  const summary = document.getElementById('order-summary');

  if (cart.length === 0) {
    window.location.href = getCartPath();
    return;
  }

  const currency = CURRENCY;

  // Totales: usar directamente item.price del carrito (ya incluye extras)
  let totalBeforeDiscount = 0;
  cart.forEach(item => {
    const qty = parseInt(item.quantity || 1);
    totalBeforeDiscount += parseFloat(item.price || 0) * qty;
  });
  const discount = calculateSecondUnitDiscountCart(cart);
  const totalGross = totalBeforeDiscount - discount;
  const base = totalGross / 1.21;
  const iva = totalGross - base;

  summary.innerHTML = `
    ${cart.map(item => `
      <div class="cart-summary-row">
        <span>
          ${escapeHtml(item.name)}${item.modelName ? ' · ' + escapeHtml(item.modelName) : ''}
          ${item.notes ? `<br><small style="opacity:0.8;">Notas: ${escapeHtml(item.notes)}</small>` : ''}
          ${item.extras ? `<br><small style="opacity:0.8;">Extras: ${[
            item.extras.upscale ? `Upscale +5 ${item.extras.currency}` : null,
            item.extras.qr ? `QR +5 ${item.extras.currency}${item.extras.qrMessage ? `: ${escapeHtml(item.extras.qrMessage)}` : ''}` : null,
            item.extras.adapter ? `Adaptador USB +4 ${item.extras.currency}` : null
          ].filter(Boolean).join(' · ')}</small>` : ''}
        </span>
        <span>${currency.symbol} ${(parseFloat(item.price || 0) * item.quantity).toFixed(2)}</span>
      </div>
    `).join('')}
    <div class="cart-summary-row">
      <span>Base (sin IVA):</span>
      <span>${currency.symbol} ${base.toFixed(2)}</span>
    </div>
    <div class="cart-summary-row">
      <span>Envío:</span>
      <span style="color: #90ee90;">Gratis</span>
    </div>
    <div class="cart-summary-row">
      <span>IVA (21%):</span>
      <span>${currency.symbol} ${iva.toFixed(2)}</span>
    </div>
    ${discount > 0 ? `
    <div class="cart-summary-row">
      <span>Descuento 2ª unidad (15%):</span>
      <span style="color: #90ee90;">-${currency.symbol} ${discount.toFixed(2)}</span>
    </div>
    ` : ''}
    <div class="cart-summary-row total">
      <span>TOTAL:</span>
      <span>${currency.symbol} ${totalGross.toFixed(2)}</span>
    </div>
  `;
}

function calculateSecondUnitDiscountCart(cart) {
  if (!Array.isArray(cart)) return 0;
  return cart.reduce((discount, item) => {
    const qty = parseInt(item.quantity || 1);
    const unit = parseFloat(item.price || 0);
    if (!Number.isFinite(qty) || qty < 2 || !Number.isFinite(unit)) return discount;
    const discountedUnits = Math.floor(qty / 2);
    return discount + (unit * SECOND_UNIT_DISCOUNT_RATE * discountedUnits);
  }, 0);
}

function updateTotalAmount() {
  let total = getCartTotal(); // precios ya incluyen IVA
  document.getElementById('total-amount').textContent = total.toFixed(2);
  const symbolEl = document.getElementById('currency-symbol');
  if (symbolEl) symbolEl.textContent = CURRENCY.symbol + ' ';
  updatePayButtonLabel(CURRENCY, total);
  if (document.getElementById('cart-badge')) {
    document.getElementById('cart-badge').textContent = getCartCount();
  }
}

async function handleCheckout(e) {
  e.preventDefault();

  const form = document.getElementById('checkout-form');
  const statusDiv = document.getElementById('payment-status');
  const submitBtn = form.querySelector('button[type="submit"]');

  const cart = getCart();
  if (cart.length === 0) {
    statusDiv.className = 'status error';
    statusDiv.textContent = '✗ Tu carrito está vacío';
    return;
  }

  // Get form data
  const currency = CURRENCY;

  const customerData = getCustomerData(form);

  submitBtn.disabled = true;
  submitBtn.textContent = 'Procesando...';
  statusDiv.textContent = '';

  try {
    if (!stripe || !elements) {
      throw new Error('No se pudo inicializar el método de pago. Recarga la página.');
    }

    savePendingOrder({ cart, customerData, currency: 'chf' });

    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}${getCheckoutPath()}`
      },
      redirect: 'if_required'
    });

    if (error) {
      throw new Error(error.message);
    }

    if (paymentIntent && paymentIntent.status === 'succeeded') {
      await finalizeOrder(paymentIntent.id);
      return;
    }

    if (paymentIntent && paymentIntent.status === 'processing') {
      statusDiv.className = 'status success';
      statusDiv.textContent = 'Pago en proceso. Serás redirigido si es necesario.';
      return;
    }
  } catch (err) {
    console.error('Checkout error:', err);
    statusDiv.className = 'status error';
    statusDiv.textContent = `✗ ${err.message}`;
    submitBtn.disabled = false;
    // Reset button label with current currency
    const currReset = CURRENCY;
    let totalReset = getCartTotal(); // sin conversión
    submitBtn.textContent = `Pagar ${currReset.symbol} ${totalReset.toFixed(2)}`;
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

function updatePayButtonLabel(currency, total) {
  const btn = document.querySelector('#checkout-form button[type="submit"]');
  if (!btn) return;
  const curr = currency || CURRENCY;
  const amount = Number.isFinite(total) ? total : getCartTotal();
  btn.textContent = `Pagar ${curr.symbol} ${amount.toFixed(2)}`;
}

async function setupPaymentElement() {
  const statusDiv = document.getElementById('payment-status');
  try {
    if (!stripe) {
      throw new Error('Stripe no está listo');
    }
    const cart = getCart();
    if (!cart.length) return;

    const currency = CURRENCY;

    const form = document.getElementById('checkout-form');
    const customerData = getCustomerData(form);

    const response = await fetch('/api/create-payment-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cart,
        customerData,
        currency: 'chf'
      })
    });

    const result = await response.json();
    if (!result.ok) {
      throw new Error(result.error || 'No se pudo iniciar el pago');
    }

    clientSecret = result.clientSecret;
    paymentIntentId = result.paymentIntentId;

    if (paymentElement) {
      paymentElement.unmount();
    }

    const order = ['paypal', 'twint', 'amazon_pay', 'card'];

    elements = stripe.elements({ clientSecret });
    paymentElement = elements.create('payment', {
      layout: {
        type: 'accordion',
        defaultCollapsed: false,
        radios: true,
        spacedAccordionItems: true
      },
      paymentMethodOrder: order
    });
    paymentElement.mount('#payment-element');
  } catch (err) {
    console.error('Payment element error:', err);
    if (statusDiv) {
      statusDiv.className = 'status error';
      statusDiv.textContent = `✗ ${err.message}`;
    }
  }
}

function savePendingOrder(data) {
  try {
    localStorage.setItem('pendingOrder', JSON.stringify(data));
  } catch (e) {
    // ignore
  }
}

function getPendingOrder() {
  try {
    const raw = localStorage.getItem('pendingOrder');
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function clearPendingOrder() {
  try {
    localStorage.removeItem('pendingOrder');
  } catch (e) {
    // ignore
  }
}

async function finalizeOrder(piId) {
  const statusDiv = document.getElementById('payment-status');
  const pending = getPendingOrder();
  if (!pending) {
    throw new Error('No se encontraron datos del pedido. Intenta de nuevo.');
  }

  const response = await fetch('/api/confirm-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      paymentIntentId: piId || paymentIntentId,
      cart: pending.cart,
      customerData: pending.customerData,
      currency: pending.currency
    })
  });

  const result = await response.json();
  if (!result.ok) {
    throw new Error(result.error || 'No se pudo confirmar el pago');
  }

  statusDiv.className = 'status success';
  statusDiv.innerHTML = `
    <strong>✓ Pago realizado con éxito!</strong><br>
    <small>Se han enviado confirmaciones a tu email. Serás redirigido...</small>
  `;

  clearCart();
  clearPendingOrder();

  setTimeout(() => {
    window.location.href = `${getSuccessPath()}?orderId=${result.orderId}`;
  }, 1500);
}

async function handleReturnFromRedirect() {
  const params = new URLSearchParams(window.location.search);
  const piId = params.get('payment_intent');
  if (!piId) return false;

  const statusDiv = document.getElementById('payment-status');
  if (statusDiv) {
    statusDiv.className = 'status';
    statusDiv.textContent = 'Confirmando pago...';
  }

  try {
    await finalizeOrder(piId);
  } catch (err) {
    console.error('Return confirm error:', err);
    if (statusDiv) {
      statusDiv.className = 'status error';
      statusDiv.textContent = `✗ ${err.message}`;
    }
  }

  return true;
}

function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

document.addEventListener('DOMContentLoaded', () => {
  initializeCheckout();
});
