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
  let cart = getCart();
  const normalized = normalizeCart(cart);
  if (normalized.changed) {
    cart = normalized.cart;
    saveCart(cart);
  } else {
    cart = normalized.cart;
  }

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
  container.innerHTML = cart.map(item => {
    const extrasText = getExtrasSummary(item);
    return `
    <div class="cart-item">
      <div class="cart-item-info">
        <h4>${escapeHtml(item.name)}${item.modelName ? ' · ' + escapeHtml(item.modelName) : ''}</h4>
        <p style="opacity: 0.7;">Producto #${item.id}${item.modelId ? ` · Modelo #${item.modelId}` : ''}</p>
        ${item.notes ? `<p style="opacity:0.8; margin-top:4px;">Notas: ${escapeHtml(item.notes)}</p>` : ''}
        ${extrasText ? `<p style="opacity:0.8; margin-top:4px;">Extras: ${extrasText}</p>` : ''}
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
  `;
  }).join('');

  // Render summary
  const total = calculateCartTotalDisplay(cart, currency);
  const count = getCartCount();
  const base = total / 1.21;
  const iva = total - base;
  document.getElementById('summary-content').innerHTML = `
    <div class="cart-summary-row">
      <span>Base (sin IVA) · ${count} artículos:</span>
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
    <div class="cart-summary-row total">
      <span>TOTAL:</span>
      <span>${currency.symbol} ${total.toFixed(2)}</span>
    </div>
  `;
}

function calculateItemTotalDisplay(item, currency) {
  const qty = parseInt(item.quantity || 1);
    // item.price ya tiene base + extras, no convertir
    return parseFloat(item.price || 0) * qty;
}

function calculateCartTotalDisplay(cart, currency) {
  // Todos los precios en carrito ya están calculados, solo sumar
  let total = 0;
  cart.forEach(item => {
    const qty = parseInt(item.quantity || 1);
    total += parseFloat(item.price || 0) * qty;
  });
  return total;
}

function getExtrasSummary(item) {
  const extras = item.extras || {};
  const currency = extras.currency || 'CHF';
  const parts = [
    extras.upscale ? `Upscale +5 ${currency}` : null,
    extras.qr ? `QR +5 ${currency}${extras.qrMessage ? `: ${escapeHtml(extras.qrMessage)}` : ''}` : null,
    extras.adapter ? `Adaptador USB +4 ${currency}` : null
  ].filter(Boolean);
  return parts.join(' · ');
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
  const lang = document.documentElement.lang || 'es';
  if (lang === 'de') {
    window.location.href = '/gallery-de';
    return;
  }
  if (lang === 'fr') {
    window.location.href = '/gallery-fr';
    return;
  }
  window.location.href = '/gallery';
}

function goToCheckout() {
  const lang = document.documentElement.lang || 'es';
  if (lang === 'de') {
    window.location.href = '/checkout-de';
    return;
  }
  if (lang === 'fr') {
    window.location.href = '/checkout-fr';
    return;
  }
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
  return String(text || '').replace(/[&<>"']/g, m => map[m]);
}

function normalizeCart(cart) {
  let changed = false;
  const normalized = (cart || []).map(item => {
    const legacy = (item && typeof item.id === 'object' && item.id !== null) ? item.id : null;
    const id = item.id ?? item.product_id ?? item.productId ?? legacy?.product_id ?? legacy?.id;
    const name = item.name ?? item.product_name ?? item.productName ?? legacy?.product_name ?? legacy?.name ?? 'Producto';
    const modelId = item.modelId ?? item.model_id ?? legacy?.model_id ?? null;
    const modelName = item.modelName ?? item.model_name ?? legacy?.model_name ?? null;
    const price = item.price ?? item.product_price ?? item.basePrice ?? item.precio ?? legacy?.product_price ?? legacy?.price ?? 0;
    const quantity = item.quantity ?? item.qty ?? legacy?.quantity ?? 1;
    const notes = item.notes ?? legacy?.notes ?? '';
    const images = Array.isArray(item.images)
      ? item.images
      : (Array.isArray(item.uploaded_files)
        ? item.uploaded_files
        : (Array.isArray(legacy?.uploaded_files) ? legacy.uploaded_files : []));
    const rawExtras = item.extras || legacy?.extras || {};
    const extras = {
      upscale: !!(rawExtras.upscale ?? rawExtras.extra_upscale),
      qr: !!(rawExtras.qr ?? rawExtras.extra_qr),
      qrMessage: rawExtras.qrMessage ?? rawExtras.qr_message ?? rawExtras.extra_qr_message ?? '',
      adapter: !!(rawExtras.adapter ?? rawExtras.extra_adapter),
      extrasTotal: rawExtras.extrasTotal ?? rawExtras.extras_total ?? 0,
      currency: rawExtras.currency || 'CHF'
    };

    const normalizedItem = {
      ...item,
      id,
      name,
      modelId,
      modelName,
      price: parseFloat(price || 0),
      quantity: parseInt(quantity || 1),
      notes,
      images,
      extras
    };

    if (
      item.id !== normalizedItem.id ||
      item.name !== normalizedItem.name ||
      item.modelId !== normalizedItem.modelId ||
      item.modelName !== normalizedItem.modelName ||
      item.price !== normalizedItem.price ||
      item.quantity !== normalizedItem.quantity ||
      item.notes !== normalizedItem.notes ||
      item.images !== normalizedItem.images ||
      item.extras !== normalizedItem.extras
    ) {
      changed = true;
    }

    return normalizedItem;
  }).filter(item => {
    if (item.id === undefined || item.id === null || item.id === '' || Number.isNaN(Number(item.id))) {
      changed = true;
      return false;
    }
    return true;
  });

  return { cart: normalized, changed };
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
