// Cart Management with localStorage
const CART_KEY = 'litum3d_cart';

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

function addToCart(productId, productName, productPrice) {
  const cart = getCart();
  const existing = cart.find(item => item.id === productId);
  
  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({
      id: productId,
      name: productName,
      price: parseFloat(productPrice),
      quantity: 1
    });
  }
  
  saveCart(cart);
  showCartNotification(`${productName} añadido al carrito`);
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

function getCartTotal() {
  return getCart().reduce((total, item) => total + (item.price * item.quantity), 0);
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
