// Cart Management with localStorage
const CART_KEY = 'litum3d_cart';
const SECOND_UNIT_DISCOUNT_RATE = 0.15;

function getCart() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY)) || [];
  } catch {
    return [];
  }
}

function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  updateCartBadge();
}

function addToCart(productId, productName, productPrice, options = {}) {
  const {
    modelId = null,
    modelName = null,
    priceDelta = 0,
    images = [],
    notes = '',
    extras = { upscale: false, qr: false, qrMessage: '', adapter: false, extrasTotal: 0, currency: 'CHF' }
  } = options;

  const unitPrice = parseFloat(productPrice) + parseFloat(priceDelta || 0) + parseFloat(extras?.extrasTotal || 0);
  const cart = getCart();

  // Si no hay personalización ni modelo, agrupar por producto
  const canMerge = !modelId && (!images || images.length === 0) && !notes;
  const existing = canMerge ? cart.find(item => item.id === productId && !item.modelId) : null;

  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({
      id: productId,
      modelId,
      modelName,
      name: productName,
      basePrice: parseFloat(productPrice),
      priceDelta: parseFloat(priceDelta || 0),
      extras: extras,
      price: unitPrice,
      quantity: 1,
      images: Array.isArray(images) ? images.slice(0, 3) : [],
      notes: notes || ''
    });
  }
  
  saveCart(cart);
  showCartNotification(`${productName}${modelName ? ' - ' + modelName : ''} añadido al carrito`);
}

function removeFromCart(productId) {
  let cart = getCart();
  cart = cart.filter(item => item.id !== productId);
  saveCart(cart);
}

function updateCartQuantity(productId, quantity) {
  const cart = getCart();
  const item = cart.find(item => item.id === productId);
  if (item) {
    if (quantity <= 0) {
      removeFromCart(productId);
    } else {
      item.quantity = quantity;
      saveCart(cart);
    }
  }
}

function clearCart() {
  localStorage.removeItem(CART_KEY);
  updateCartBadge();
}

function calculateSecondUnitDiscount(cart) {
  if (!Array.isArray(cart)) return 0;
  return cart.reduce((discount, item) => {
    const qty = parseInt(item.quantity || 1);
    const unit = parseFloat(item.price || 0);
    if (!Number.isFinite(qty) || qty < 2 || !Number.isFinite(unit)) return discount;
    const discountedUnits = Math.floor(qty / 2);
    return discount + (unit * SECOND_UNIT_DISCOUNT_RATE * discountedUnits);
  }, 0);
}

function getCartTotal() {
  const cart = getCart();
  const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const discount = calculateSecondUnitDiscount(cart);
  return total - discount;
}

function getCartCount() {
  return getCart().reduce((count, item) => count + item.quantity, 0);
}

function updateCartBadge() {
  const count = getCartCount();
  const badges = document.querySelectorAll('.cart-badge');
  badges.forEach(badge => {
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
    }
  });
}

function showCartNotification(message) {
  // Create notification
  const notif = document.createElement('div');
  notif.className = 'cart-notification';
  notif.innerHTML = `
    <div style="background: rgba(76, 175, 80, 0.2); border: 1px solid rgba(76, 175, 80, 0.4); color: #90ee90; padding: 1rem; border-radius: 6px; font-weight: 500;">
      ✓ ${message}
    </div>
  `;
  document.body.appendChild(notif);
  
  setTimeout(() => notif.remove(), 3000);
}

// Initialize cart badge on page load
document.addEventListener('DOMContentLoaded', updateCartBadge);
