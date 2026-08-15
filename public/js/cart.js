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

// Normaliza una lista de IDs de product_variant_options: enteros positivos,
// sin duplicados, orden determinista. Descarta silenciosamente cualquier
// valor no numérico (undefined/null/NaN/strings no numéricas) en vez de
// inventar o adivinar un ID. No representa deltas ni nombres, solo IDs.
function normalizeVariantOptionIds(rawIds) {
  if (!Array.isArray(rawIds)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of rawIds) {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    result.push(n);
  }
  result.sort((a, b) => a - b);
  return result;
}

// Un item de carrito "sin personalización" es el único caso en el que dos
// clics de "añadir" del mismo producto deben fusionarse incrementando la
// cantidad. Cualquier selección real (modelo, variantes, extras, imágenes,
// notas) hace que cada personalización viva en su propia línea del carrito.
function hasNoPersonalization(entry) {
  const noModel = !entry.modelId;
  const noVariants = !Array.isArray(entry.variantOptionIds) || entry.variantOptionIds.length === 0;
  const noImages = !entry.images || entry.images.length === 0;
  const noNotes = !entry.notes;
  const noExtras = !entry.extras || (!entry.extras.upscale && !entry.extras.qr && !entry.extras.adapter);
  return noModel && noVariants && noImages && noNotes && noExtras;
}

function addToCart(productId, productName, productPrice, options = {}) {
  const {
    modelId = null,
    modelName = null,
    priceDelta = 0, // Legacy pricing field — remove after canonical checkout cutover
    variantOptionIds = [],
    images = [],
    notes = '',
    extras = { upscale: false, qr: false, qrMessage: '', adapter: false, extrasTotal: 0, currency: 'CHF' }
  } = options;

  const normalizedVariantOptionIds = normalizeVariantOptionIds(variantOptionIds);

  // Legacy pricing field — remove after canonical checkout cutover
  const unitPrice = parseFloat(productPrice) + parseFloat(priceDelta || 0) + parseFloat(extras?.extrasTotal || 0);
  const cart = getCart();

  // Si no hay personalización real (ni modelo, ni variantes, ni extras, ni
  // fotos, ni notas), agrupar por producto incrementando cantidad. Dos
  // personalizaciones distintas del mismo producto nunca se fusionan.
  const candidate = { modelId, variantOptionIds: normalizedVariantOptionIds, images, notes, extras };
  const canMerge = hasNoPersonalization(candidate);
  const existing = canMerge ? cart.find(item => item.id === productId && hasNoPersonalization(item)) : null;

  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({
      id: productId,
      modelId,
      modelName,
      variantOptionIds: normalizedVariantOptionIds,
      name: productName,
      basePrice: parseFloat(productPrice), // Legacy pricing field — remove after canonical checkout cutover
      priceDelta: parseFloat(priceDelta || 0), // Legacy pricing field — remove after canonical checkout cutover
      extras: extras, // extras.extrasTotal/currency son legacy; upscale/qr/adapter/qrMessage son selecciones canónicas
      price: unitPrice, // Legacy pricing field — remove after canonical checkout cutover
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
