// Stripe Checkout
const stripe = Stripe('pk_test_51SJ8AN5cIO4mUIxs5UYdUSVOT1lN3CSu2YNDEtI1kayJH9tYyioND7nLcmZWxA1MpdZjuEebZM8PB3BgoDKeU3Sj00YdMnl7UN');
let cardElement;
const CURRENCY_MAP = { ES: { code: 'EUR', symbol: '€' }, CH: { code: 'CHF', symbol: 'CHF' } };
let eurChfRate = 1.00; // live rate fetched from backend when needed

function initializeCheckout() {
  const elements = stripe.elements();
  cardElement = elements.create('card', {
    hidePostalCode: true
  });
  cardElement.mount('#card-element');

  // Render order summary
  renderOrderSummary();
  updateTotalAmount();

  // Form submission
  document.getElementById('checkout-form').addEventListener('submit', handleCheckout);
  // Preload FX if CH is selected by default
  const countrySel = document.getElementById('customer_country');
  if (countrySel && countrySel.value === 'CH') {
    loadFxRate();
  }
}

function renderOrderSummary() {
  const cart = getCart();
  const summary = document.getElementById('order-summary');

  if (cart.length === 0) {
    window.location.href = '/cart';
    return;
  }

  const countrySel = document.getElementById('customer_country');
  const country = countrySel ? countrySel.value : 'ES';
  const currency = CURRENCY_MAP[country] || CURRENCY_MAP['ES'];

  // Compute totals consistently with backend
  let subtotalBaseEur = 0;
  let subtotalExtrasCurr = 0;

  cart.forEach(item => {
    const qty = parseInt(item.quantity || 1);
    const baseUnitEur = parseFloat(item.basePrice || 0) + parseFloat(item.priceDelta || 0);
    subtotalBaseEur += baseUnitEur * qty;
    const ex = item.extras || {};
    const extrasUnit = (ex.upscale ? 5 : 0) + (ex.qr ? 5 : 0) + (ex.adapter ? 4 : 0);
    subtotalExtrasCurr += extrasUnit * qty;
  });

  const subtotalBaseCurr = currency.code === 'CHF' ? (subtotalBaseEur * eurChfRate) : subtotalBaseEur;
  const totalNoTax = subtotalBaseCurr + subtotalExtrasCurr;
  const withTax = totalNoTax * 1.21;

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
        <span>${currency.symbol} ${( ( (parseFloat(item.basePrice||0) + parseFloat(item.priceDelta||0)) * (currency.code==='CHF'? eurChfRate:1) ) * item.quantity + ( (item.extras?.upscale?5:0)+(item.extras?.qr?5:0)+(item.extras?.adapter?4:0) ) * item.quantity ).toFixed(2)}</span>
      </div>
    `).join('')}
    <div class="cart-summary-row">
      <span>Subtotal:</span>
      <span>${currency.symbol} ${totalNoTax.toFixed(2)}</span>
    </div>
    <div class="cart-summary-row">
      <span>Envío:</span>
      <span style="color: #90ee90;">Gratis</span>
    </div>
    <div class="cart-summary-row">
      <span>IVA (21%):</span>
      <span>${currency.symbol} ${(totalNoTax * 0.21).toFixed(2)}</span>
    </div>
    <div class="cart-summary-row total">
      <span>TOTAL:</span>
      <span>${currency.symbol} ${withTax.toFixed(2)}</span>
    </div>
  `;
}

function updateTotalAmount() {
  const countrySel = document.getElementById('customer_country');
  const country = countrySel ? countrySel.value : 'ES';
  const currency = CURRENCY_MAP[country] || CURRENCY_MAP['ES'];
  let total = getCartTotal() * 1.21; // base EUR
  if (currency.code === 'CHF') {
    total = total * eurChfRate; // convert using live rate
  }
  document.getElementById('total-amount').textContent = total.toFixed(2);
  const symbolEl = document.getElementById('currency-symbol');
  if (symbolEl) symbolEl.textContent = currency.symbol + ' ';
  if (document.getElementById('cart-badge')) {
    document.getElementById('cart-badge').textContent = getCartCount();
  }
}

function onCountryChange() {
  const countrySel = document.getElementById('customer_country');
  const country = countrySel ? countrySel.value : 'ES';
  if (country === 'CH') {
    loadFxRate().finally(updateTotalAmount);
  } else {
    eurChfRate = 1.00;
    updateTotalAmount();
  }
}

async function loadFxRate() {
  try {
    const resp = await fetch('/api/fx/eur-chf');
    const data = await resp.json();
    if (data.ok && Number.isFinite(data.rate) && data.rate > 0) {
      eurChfRate = parseFloat(data.rate);
    }
  } catch (e) {
    // keep previous or default
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
  const countrySel = document.getElementById('customer_country');
  const country = countrySel ? countrySel.value : 'ES';
  const currency = CURRENCY_MAP[country] || CURRENCY_MAP['ES'];

  const customerData = {
    name: form.customer_name.value,
    email: form.customer_email.value,
    phone: form.customer_phone.value,
    address: form.customer_address.value,
    city: form.customer_city.value,
    zip: form.customer_zip.value,
    country: country
  };

  submitBtn.disabled = true;
  submitBtn.textContent = 'Procesando...';
  statusDiv.textContent = '';

  try {
    // Create payment method with Stripe
    const { paymentMethod, error } = await stripe.createPaymentMethod({
      type: 'card',
      card: cardElement,
      billing_details: {
        name: customerData.name,
        email: customerData.email,
        address: {
          line1: customerData.address,
          city: customerData.city,
          postal_code: customerData.zip,
          country: customerData.country
        },
        phone: customerData.phone
      }
    });

    if (error) {
      throw new Error(error.message);
    }

    // Send to backend
    const response = await fetch('/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paymentMethodId: paymentMethod.id,
        cart: cart,
        customerData: customerData,
        currency: currency.code.toLowerCase()
      })
    });

    const result = await response.json();

    if (!result.ok) {
      throw new Error(result.error || 'Error al procesar el pago');
    }

    // Success
    statusDiv.className = 'status success';
    statusDiv.innerHTML = `
      <strong>✓ Pago realizado con éxito!</strong><br>
      <small>Se han enviado confirmaciones a tu email. Serás redirigido...</small>
    `;

    clearCart();

    // Redirect after 3 seconds
    setTimeout(() => {
      window.location.href = `/success?orderId=${result.orderId}`;
    }, 3000);

  } catch (err) {
    console.error('Checkout error:', err);
    statusDiv.className = 'status error';
    statusDiv.textContent = `✗ ${err.message}`;
    submitBtn.disabled = false;
    // Reset button label with current currency
    const countryReset = document.getElementById('customer_country')?.value || 'ES';
    const currReset = CURRENCY_MAP[countryReset] || CURRENCY_MAP['ES'];
    let totalReset = getCartTotal() * 1.21;
    if (currReset.code === 'CHF') totalReset = totalReset * eurChfRate;
    submitBtn.textContent = `Pagar ${currReset.symbol} ${totalReset.toFixed(2)}`;
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
  return text.replace(/[&<>"']/g, m => map[m]);
}

document.addEventListener('DOMContentLoaded', initializeCheckout);
