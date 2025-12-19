// Cart Page Management
function renderCartItems() {
  const container = document.getElementById('cart-items-container');
  const summary = document.getElementById('cart-summary');
  const cart = getCart();

  if (cart.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 2rem;">
        <p style="font-size: 3rem; margin: 0;">🛒</p>
        <h3 style="color: var(--gold);">Tu carrito está vacío</h3>
        <p style="opacity: 0.8;">Descubre nuestros productos y añade tus favoritos</p>
        <a href="/gallery" style="display: inline-block; margin-top: 1rem; padding: 0.8rem 1.5rem; background: linear-gradient(135deg, var(--gold), #f0c070); color: var(--primary); border-radius: 6px; text-decoration: none; font-weight: 700;">
          Explorar Productos
        </a>
      </div>
    `;
    summary.style.display = 'none';
    return;
  }

  summary.style.display = 'block';

  // Render items
  container.innerHTML = cart.map(item => `
    <div class="cart-item">
      <div class="cart-item-info">
        <h4>${escapeHtml(item.name)}</h4>
        <p style="opacity: 0.7;">Producto #${item.id}</p>
      </div>
      <div class="cart-item-price">
        €${item.price.toFixed(2)}
      </div>
      <div class="cart-item-qty">
        <button onclick="updateQty(${item.id}, ${item.quantity - 1})" style="padding: 0.3rem 0.6rem; background: rgba(224, 173, 97, 0.2); border: none; color: var(--gold); border-radius: 4px; cursor: pointer;">−</button>
        <input type="number" value="${item.quantity}" onchange="updateQty(${item.id}, parseInt(this.value))" min="1" max="10" />
        <button onclick="updateQty(${item.id}, ${item.quantity + 1})" style="padding: 0.3rem 0.6rem; background: rgba(224, 173, 97, 0.2); border: none; color: var(--gold); border-radius: 4px; cursor: pointer;">+</button>
      </div>
      <button class="cart-item-remove" onclick="removeFromCart(${item.id}); renderCartItems();">
        ✕ Eliminar
      </button>
    </div>
  `).join('');

  // Render summary
  const total = getCartTotal();
  const count = getCartCount();
  document.getElementById('summary-content').innerHTML = `
    <div class="cart-summary-row">
      <span>Subtotal (${count} artículos):</span>
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
      <span>€${(total * 1.21).toFixed(2)}</span>
    </div>
  `;
}

function updateQty(productId, newQty) {
  if (newQty <= 0) {
    removeFromCart(productId);
  } else {
    updateCartQuantity(productId, newQty);
  }
  renderCartItems();
  updateCartBadge();
}
  renderCartItems();
}

function continueShopping() {
  window.location.href = '/gallery';
}

function goToCheckout() {
  window.location.href = '/checkout';
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

// Initialize on page load
document.addEventListener('DOMContentLoaded', renderCartItems);
