// Load all products for gallery
async function loadGallery() {
  const container = document.getElementById('gallery-products');
  try {
    const [resProducts, resStatic] = await Promise.all([
      fetch('/api/productos'),
      fetch('/api/galeria-estatica')
    ]);

    if (!resProducts.ok) throw new Error('Error al obtener productos');

    const dbProducts = await resProducts.json();
    const staticImages = resStatic.ok ? await resStatic.json() : [];

    const usedImages = new Set((dbProducts || []).map(p => p.imagen || ''));
    const merged = [
      ...dbProducts,
      ...staticImages.filter(item => item.imagen && !usedImages.has(item.imagen))
    ];

    if (!merged || merged.length === 0) {
      container.innerHTML = '<p style="grid-column: 1/-1; text-align: center;">No hay productos disponibles.</p>';
      return;
    }
    
    container.innerHTML = merged.map((p, idx) => `
      <div class="product-card" style="animation-delay: ${idx * 0.1}s;">
        <div class="product-image">
          ${p.imagen 
            ? `<img src="/img/productos/${p.imagen}" alt="${escapeHtml(p.nombre)}" onerror="this.onerror=null; this.parentElement.innerHTML='${getEmojiForProduct(p.nombre)}';">` 
            : getEmojiForProduct(p.nombre)
          }
        </div>
        <div class="product-content">
          <h3 class="product-name">${escapeHtml(p.nombre)}</h3>
          <p class="product-desc">${escapeHtml(p.descripcion || 'Litofanía premium con acabado profesional')}</p>
          <div class="product-footer">
            <span class="product-price">€${Number.isFinite(Number(p.precio)) ? Number(p.precio).toFixed(2) : '0.00'}</span>
            <span class="product-stock">${Number(p.stock) > 0 ? '✓ Stock' : 'Agotado'}</span>
          </div>
          <button class="product-buy-btn" onclick="addToCart(${p.id}, '${escapeHtml(p.nombre)}', ${p.precio || 0})" ${Number(p.stock) > 0 ? '' : 'disabled'}>
            ${Number(p.stock) > 0 ? '🛒 Comprar Ahora' : 'Agotado'}
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
