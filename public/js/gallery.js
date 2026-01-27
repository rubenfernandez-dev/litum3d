// ============================================
// Gallery Page - Filtrado por Colecciones
// ============================================

let allGalleryImages = [];
let currentFilter = 'todas';

// Galería estática con URLs externas y colección definida
// Sustituye las URLs de ejemplo por las tuyas (Cloudinary u otras)
const STATIC_GALLERY = [
  {
    id: 'fam-1',
    nombre: 'Familia en la playa',
    collection: 'familia',
    imagen: 'https://res.cloudinary.com/demo/image/upload/sample.jpg'
  },
  {
    id: 'mas-1',
    nombre: 'Mascota feliz',
    collection: 'mascotas',
    imagen: 'https://res.cloudinary.com/demo/image/upload/sample.jpg'
  },
  {
    id: 'par-1',
    nombre: 'Pareja en atardecer',
    collection: 'parejas',
    imagen: 'https://res.cloudinary.com/demo/image/upload/sample.jpg'
  },
  {
    id: 'bod-1',
    nombre: 'Boda en jardín',
    collection: 'bodas',
    imagen: 'https://res.cloudinary.com/demo/image/upload/sample.jpg'
  },
  {
    id: 'viaj-1',
    nombre: 'Viajes',
    collection: 'viajes',
    imagen: 'https://res.cloudinary.com/demo/image/upload/sample.jpg'
  },
    {
    id: 'paisaje-1',
    nombre: 'Paisajes',
    collection: 'paisajes',
    imagen: 'https://res.cloudinary.com/demo/image/upload/sample.jpg'
  },
    {
    id: 'anime-1',
    nombre: 'Anime',
    collection: 'anime',
    imagen: 'https://res.cloudinary.com/demo/image/upload/sample.jpg'
  },
];

/**
 * Cargar todas las imágenes de galería
 */
async function loadGallery() {
  const container = document.getElementById('gallery-products');
  try {
    const staticImages = STATIC_GALLERY;

    if (!staticImages || staticImages.length === 0) {
      container.innerHTML = '<p style="grid-column: 1/-1; text-align: center; padding: 40px; color: #e0ad61;">No hay imágenes disponibles en la galería.</p>';
      return;
    }

    // Ya vienen con collection definida
    allGalleryImages = staticImages;

    renderGallery(allGalleryImages);
  } catch (err) {
    console.error(err);
    container.innerHTML = '<p style="grid-column: 1/-1; color: #ff6b6b; text-align: center; padding: 40px;">Error al cargar galería.</p>';
  }
}

/**
 * Determinar colección de imagen según su nombre o índice
 */
function getCollectionForImage(img, index) {
  const name = (img.nombre || img.imagen || '').toLowerCase();

  if (name.includes('familia') || name.includes('familia')) return 'familia';
  if (name.includes('mascota') || name.includes('pet') || name.includes('gato') || name.includes('perro')) return 'mascotas';
  if (name.includes('pareja') || name.includes('couple') || name.includes('amor')) return 'parejas';
  if (name.includes('boda') || name.includes('wedding') || name.includes('matrimonio')) return 'bodas';
  if (name.includes('viaje') || name.includes('travel') || name.includes('vacaciones')) return 'viajes';
  if (name.includes('paisaje') || name.includes('landscape') || name.includes('naturaleza')) return 'paisajes';
  if (name.includes('anime') || name.includes('manga') || name.includes('dibujos')) return 'anime';

  // Asignación por índice como fallback
  const collections = ['familia', 'mascotas', 'parejas', 'bodas', 'viajes', 'paisajes', 'anime'];
  return collections[index % collections.length];
}

/**
 * Renderizar imágenes de galería
 */
function renderGallery(images) {
  const container = document.getElementById('gallery-products');

  if (images.length === 0) {
    container.innerHTML = '<p style="grid-column: 1/-1; text-align: center; padding: 40px; color: #e0ad61;">No hay imágenes en esta colección.</p>';
    return;
  }

  container.innerHTML = images.map((img, idx) => `
    <div class="product-card gallery-card" style="animation-delay: ${idx * 0.05}s;" onclick="openImageModal('${escapeHtml(img.imagen)}', '${escapeHtml(img.nombre || 'Galería')}')">
      <div class="product-image">
        ${img.imagen
          ? `<img src="${escapeHtml(img.imagen)}" alt="${escapeHtml(img.nombre || 'Galería')}" onerror="this.onerror=null; this.parentElement.innerHTML='✨';">`
          : '✨'
        }
      </div>
      <div class="gallery-card-overlay">
        <button class="gallery-cta-btn" onclick="event.stopPropagation(); openImageModal('${escapeHtml(img.imagen)}', '${escapeHtml(img.nombre || 'Galería')}')">
          ✨ Crear una litofanía como esta
        </button>
      </div>
    </div>
  `).join('');
}

/**
 * Filtrar galería por colección
 */
function filterGallery(collection) {
  currentFilter = collection;

  // Actualizar botones activos
  document.querySelectorAll('.gallery-filter-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  event.target.classList.add('active');

  // Filtrar imágenes
  if (collection === 'todas') {
    renderGallery(allGalleryImages);
  } else {
    const filtered = allGalleryImages.filter(img => img.collection === collection);
    renderGallery(filtered);
  }
}

/**
 * Abrir modal de imagen
 */
function openImageModal(imagePath, imageName) {
  // Crear modal
  const modal = document.createElement('div');
  modal.className = 'image-modal';
  modal.innerHTML = `
    <div class="image-modal-content">
      <button class="image-modal-close" onclick="this.parentElement.parentElement.remove()">✕</button>
      <img src="${escapeHtml(imagePath)}" alt="${escapeHtml(imageName)}" class="image-modal-image">
      <div class="image-modal-actions">
        <a href="/tienda" class="image-modal-cta">✨ Crear una litofanía como esta</a>
      </div>
    </div>
  `;

  // Agregar estilos al modal
  modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.85);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
    padding: 20px;
    animation: fadeIn 0.3s ease;
  `;

  document.body.appendChild(modal);
  modal.onclick = (e) => {
    if (e.target === modal) modal.remove();
  };
}

/**
 * Helpers
 */
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}

function getEmojiForProduct(name) {
  if (name.toLowerCase().includes('dragon')) return '🐉';
  if (name.toLowerCase().includes('busto')) return '🗿';
  if (name.toLowerCase().includes('miniatura') || name.toLowerCase().includes('medieval')) return '⚔️';
  if (name.toLowerCase().includes('figura')) return '🎨';
  return '✨';
}

// Cargar galería al inicializar página
document.addEventListener('DOMContentLoaded', () => {
  loadGallery();
  document.getElementById('cart-badge').textContent = getCartCount();
});

