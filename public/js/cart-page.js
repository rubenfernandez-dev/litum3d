// Cart Page Management with dynamic currency
const CURRENCY_MAP = { ES: { code: 'EUR', symbol: '€' }, CH: { code: 'CHF', symbol: 'CHF' } };
let eurChfRate = 1.00;

function getCartCountry() {
  const sel = document.getElementById('cart_country');
  return sel ? sel.value : 'ES';
}

async function loadFxRateForCart() {
  try {
    const resp = await fetch('/api/fx/eur-chf');
    const data = await resp.json();
    if (data.ok && Number.isFinite(data.rate) && data.rate > 0) {
      eurChfRate = parseFloat(data.rate);
    }
  } catch {}
}

function onCartCountryChange() {
  const country = getCartCountry();
  document.getElementById('cart_currency_symbol').textContent = CURRENCY_MAP[country]?.symbol || '€';
  if (country === 'CH') {
    loadFxRateForCart().finally(renderCartItems);
  } else {
    eurChfRate = 1.00;
    renderCartItems();
  }
}
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
  const country = getCartCountry();
  const currency = CURRENCY_MAP[country] || CURRENCY_MAP['ES'];
  container.innerHTML = cart.map(item => `
    <div class="cart-item">
      <div class="cart-item-info">
        <h4>${escapeHtml(item.name)}${item.modelName ? ' · ' + escapeHtml(item.modelName) : ''}</h4>
        <p style="opacity: 0.7;">Producto #${item.id}${item.modelId ? ` · Modelo #${item.modelId}` : ''}</p>
        ${item.notes ? `<p style="opacity:0.8; margin-top:4px;">Notas: ${escapeHtml(item.notes)}</p>` : ''}
        ${item.extras ? `<p style="opacity:0.8; margin-top:4px;">Extras: ${[
            item.extras.upscale ? `Upscale +5 ${item.extras.currency}` : null,
            item.extras.qr ? `QR +5 ${item.extras.currency}${item.extras.qrMessage ? `: ${escapeHtml(item.extras.qrMessage)}` : ''}` : null,
            item.extras.adapter ? `Adaptador USB +4 ${item.extras.currency}` : null
          ].filter(Boolean).join(' · ')}</p>` : ''}
        ${Array.isArray(item.images) && item.images.length ? `
          <div style="display:flex; gap:8px; margin-top:6px; flex-wrap:wrap;">
            ${item.images.map(img => `<a href="${escapeHtml(img.url || img)}" target="_blank" style="border:1px solid rgba(255,255,255,0.1); padding:4px 6px; border-radius:4px; color: var(--gold); text-decoration:none; font-size:12px;">📎 Imagen</a>`).join('')}
          </div>
        ` : ''}
      </div>
      <div class="cart-item-price">
        ${currency.symbol} ${calculateItemTotalDisplay(item, currency).toFixed(2)}
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
  const total = calculateCartTotalDisplay(cart, currency);
  const count = getCartCount();
  document.getElementById('summary-content').innerHTML = `
    <div class="cart-summary-row">
      <span>Subtotal (${count} artículos):</span>
      <span>${currency.symbol} ${total.toFixed(2)}</span>
    </div>
    <div class="cart-summary-row">
      <span>Envío:</span>
      <span style="color: #90ee90;">Gratis</span>
    </div>
    <div class="cart-summary-row">
      <span>IVA (21%):</span>
      <span>${currency.symbol} ${(total * 0.21).toFixed(2)}</span>
    </div>
    <div class="cart-summary-row total">
      <span>TOTAL:</span>
      <span>${currency.symbol} ${(total * 1.21).toFixed(2)}</span>
    </div>
  `;
}

function calculateItemTotalDisplay(item, currency) {
  const qty = parseInt(item.quantity || 1);
  const baseUnitEur = parseFloat(item.basePrice || 0) + parseFloat(item.priceDelta || 0);
  const baseCurr = currency.code === 'CHF' ? (baseUnitEur * eurChfRate) : baseUnitEur;
  const ex = item.extras || {};
  const extrasUnit = (ex.upscale ? 5 : 0) + (ex.qr ? 5 : 0) + (ex.adapter ? 4 : 0);
  return (baseCurr + extrasUnit) * qty;
}

function calculateCartTotalDisplay(cart, currency) {
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
  return subtotalBaseCurr + subtotalExtrasCurr;
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
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('cart_currency_symbol').textContent = CURRENCY_MAP[getCartCountry()]?.symbol || '€';
  if (getCartCountry() === 'CH') {
    loadFxRateForCart().finally(renderCartItems);
  } else {
    renderCartItems();
  }
});
