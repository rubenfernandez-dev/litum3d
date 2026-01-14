// Load all products for gallery
async function loadGallery() {
  const container = document.getElementById('gallery-products');
  try {
    // Solo cargar imágenes estáticas, no productos
    const resStatic = await fetch('/api/galeria-estatica');
    const staticImages = resStatic.ok ? await resStatic.json() : [];

    if (!staticImages || staticImages.length === 0) {
      container.innerHTML = '<p style="grid-column: 1/-1; text-align: center;">No hay imágenes disponibles en la galería.</p>';
      return;
    }
    
    container.innerHTML = staticImages.map((p, idx) => `
      <div class="product-card gallery-card" style="animation-delay: ${idx * 0.1}s;">
        <div class="product-image">
          ${p.imagen 
            ? `<img src="/img/productos/${p.imagen}" alt="${escapeHtml(p.nombre || 'Galería')}" onerror="this.onerror=null; this.parentElement.innerHTML='✨';">` 
            : '✨'
          }
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
