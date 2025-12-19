// Stripe Checkout
const stripe = Stripe('pk_test_51QsLCsJqC7yL3rEXLO5S9CqJIQaHwL4QNePdJLW5RrG7C9OqXB8jEPqLZxzqVQD2ItMJr3JQ5PqHdYlkPGQ200vd00R3bxXA3L');
let cardElement;

function initializeCheckout() {
  const elements = stripe.elements();
  cardElement = elements.create('card');
  cardElement.mount('#card-element');

  // Render order summary
  renderOrderSummary();
  updateTotalAmount();

  // Form submission
  document.getElementById('checkout-form').addEventListener('submit', handleCheckout);
}

function renderOrderSummary() {
  const cart = getCart();
  const total = getCartTotal();
  const summary = document.getElementById('order-summary');

  if (cart.length === 0) {
    window.location.href = '/cart';
    return;
  }

  const withTax = total * 1.21;

  summary.innerHTML = `
    ${cart.map(item => `
      <div class="cart-summary-row">
        <span>${escapeHtml(item.name)} x${item.quantity}</span>
        <span>€${(item.price * item.quantity).toFixed(2)}</span>
      </div>
    `).join('')}
    <div class="cart-summary-row">
      <span>Subtotal:</span>
      <span>€${total.toFixed(2)}</span>
    </div>
    <div class="cart-summary-row">
      <span>Envío:</span>
      <span style="color: #90ee90;">Gratis</span>
    </div>
    <div class="cart-summary-row">
      <span>IVA (21%):</span>
      <span>€${(total * 0.21).toFixed(2)}</span>
    </div>
    <div class="cart-summary-row total">
      <span>TOTAL:</span>
      <span>€${withTax.toFixed(2)}</span>
    </div>
  `;
}

function updateTotalAmount() {
  const total = getCartTotal() * 1.21;
  document.getElementById('total-amount').textContent = total.toFixed(2);
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
  const customerData = {
    name: form.customer_name.value,
    email: form.customer_email.value,
    phone: form.customer_phone.value,
    address: form.customer_address.value,
    city: form.customer_city.value,
    zip: form.customer_zip.value
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
        email: customerData.email
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
        customerData: customerData
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
    submitBtn.textContent = `Pagar €${(getCartTotal() * 1.21).toFixed(2)}`;
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
