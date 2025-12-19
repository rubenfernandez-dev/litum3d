// Load all products for gallery
async function loadGallery() {
  const container = document.getElementById('gallery-products');
  try {
    const res = await fetch('/api/productos');
    if (!res.ok) throw new Error('Error al obtener productos');
    
    let products = await res.json();
    
    if (!products || products.length === 0) {
      container.innerHTML = '<p style="grid-column: 1/-1; text-align: center;">No hay productos disponibles.</p>';
      return;
    }
    
    container.innerHTML = products.map((p, idx) => `
      <div class="product-card" style="animation-delay: ${idx * 0.1}s;">
        <div class="product-image">
          ${getEmojiForProduct(p.nombre)}
        </div>
        <div class="product-content">
          <h3 class="product-name">${escapeHtml(p.nombre)}</h3>
          <p class="product-desc">${escapeHtml(p.descripcion || 'Litofanía premium con acabado profesional')}</p>
          <div class="product-footer">
            <span class="product-price">€${parseFloat(p.precio).toFixed(2)}</span>
            <span class="product-stock">${p.stock > 0 ? '✓ Stock' : 'Agotado'}</span>
          </div>
          <button class="product-buy-btn" onclick="addToCart(${p.id}, '${escapeHtml(p.nombre)}', ${p.precio})" ${p.stock > 0 ? '' : 'disabled'}>
            ${p.stock > 0 ? '🛒 Comprar Ahora' : 'Agotado'}
          </button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error(err);
    container.innerHTML = '<p style="grid-column: 1/-1; color: #ff6b6b; text-align: center;">Error al cargar galería.</p>';
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

function getEmojiForProduct(name) {
  if (name.toLowerCase().includes('dragon')) return '🐉';
  if (name.toLowerCase().includes('busto')) return '🗿';
  if (name.toLowerCase().includes('miniatura') || name.toLowerCase().includes('medieval')) return '⚔️';
  if (name.toLowerCase().includes('figura')) return '🎨';
  return '✨';
}

document.addEventListener('DOMContentLoaded', loadGallery);
