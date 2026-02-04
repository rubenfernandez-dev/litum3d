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
    nombre: 'Familia generacional',
    collection: 'familia',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769589514/WhatsApp_Image_2026-01-27_at_22.50.32_a4mbub.jpg'
  },
  {
    id: 'fam-1',
    nombre: 'Vino el segundo',
    collection: 'familia',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769589502/WhatsApp_Image_2026-01-27_at_22.07.13_5_lnf5wc.jpg'
  },
  {
    id: 'fam-1',
    nombre: 'Hermanos',
    collection: 'familia',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769589512/WhatsApp_Image_2026-01-27_at_22.50.32_1_asvuan.jpg'
  },
  {
    id: 'fam-1',
    nombre: 'Bebés gemelos',
    collection: 'familia',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769589511/WhatsApp_Image_2026-01-27_at_22.07.14_shtgel.jpg'
  },
  {
    id: 'fam-1',
    nombre: 'Familia al completo',
    collection: 'familia',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769589508/WhatsApp_Image_2026-01-27_at_22.07.14_2_njgqwd.jpg'
  },
  {
    id: 'fam-1',
    nombre: 'Nuestro primer bebé',
    collection: 'familia',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769589507/WhatsApp_Image_2026-01-27_at_22.07.14_1_gnelt4.jpg'
  },
  {
    id: 'fam-1',
    nombre: 'Recien nacidos',
    collection: 'familia',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769589500/WhatsApp_Image_2026-01-27_at_22.07.13_3_pasrqc.jpg'
  },
  {
    id: 'fam-1',
    nombre: 'La mayor conexión',
    collection: 'familia',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769589498/WhatsApp_Image_2026-01-27_at_22.07.13_2_n1bjku.jpg'
  },
  {
    id: 'fam-1',
    nombre: 'Lazos familiares',
    collection: 'familia',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769589497/WhatsApp_Image_2026-01-27_at_22.07.13_1_i5s81h.jpg'
  },
  {
    id: 'mas-1',
    nombre: 'Cachorros',
    collection: 'mascotas',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769516843/WhatsApp_Image_2026-01-27_at_10.22.17_pade0w.jpg'
  },
  {
    id: 'mas-1',
    nombre: 'Mi perro feliz',
    collection: 'mascotas',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769516843/WhatsApp_Image_2026-01-27_at_10.22.17_6_dt5ukq.jpg'
  },
  {
    id: 'mas-1',
    nombre: 'Gatito curioso',
    collection: 'mascotas',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769516842/WhatsApp_Image_2026-01-27_at_10.22.17_4_rjem3t.jpg'
  },
  {
    id: 'mas-1',
    nombre: 'momentos inolvidables',
    collection: 'mascotas',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769516842/WhatsApp_Image_2026-01-27_at_10.22.17_3_ky5qqa.jpg'
  },
  {
    id: 'mas-1',
    nombre: 'Mis dos mejores amigos',
    collection: 'mascotas',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769516841/WhatsApp_Image_2026-01-27_at_10.22.17_2_fgekyw.jpg'
  },
  {
    id: 'mas-1',
    nombre: 'Cachorros amorosos',
    collection: 'mascotas',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769516841/WhatsApp_Image_2026-01-27_at_10.22.17_1_eppd5z.jpg'
  },
  {
    id: 'par-1',
    nombre: 'Momentos felices',
    collection: 'parejas',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769589494/WhatsApp_Image_2026-01-27_at_23.30.30_e3pyyn.jpg'
  },
  {
    id: 'par-1',
    nombre: 'Paseo romántico',
    collection: 'parejas',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769589489/WhatsApp_Image_2026-01-27_at_23.30.30_6_wkgv3i.jpg'
  },
  {
    id: 'par-1',
    nombre: 'Oso amoroso',
    collection: 'parejas',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769589487/WhatsApp_Image_2026-01-27_at_23.30.30_4_enpmyv.jpg'
  },
  {
    id: 'par-1',
    nombre: 'Pareja San Valentin',
    collection: 'parejas',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769589493/WhatsApp_Image_2026-01-27_at_23.30.30_8_v7lllg.jpg'
  },
  {
    id: 'par-1',
    nombre: 'La Pedida',
    collection: 'parejas',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769589486/WhatsApp_Image_2026-01-27_at_23.30.30_3_odsvmk.jpg'
  },
  {
    id: 'par-1',
    nombre: 'Pareja en atardecer',
    collection: 'parejas',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769589490/WhatsApp_Image_2026-01-27_at_23.30.30_7_jm44zv.jpg'
  },
  {
    id: 'par-1',
    nombre: 'Brindis de amor',
    collection: 'parejas',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769589487/WhatsApp_Image_2026-01-27_at_23.30.30_5_soou9l.jpg'
  },
  {
    id: 'par-1',
    nombre: 'Viene el primero',
    collection: 'parejas',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769589495/WhatsApp_Image_2026-01-27_at_22.07.12_exiab2.jpg'
  },
  {
    id: 'bod-1',
    nombre: 'Boda en las mmontañas',
    collection: 'bodas',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769516844/WhatsApp_Image_2026-01-27_at_10.22.18_2_bxfgsn.jpg'
  },
  {
    id: 'bod-1',
    nombre: 'Boda en la iglesia',
    collection: 'bodas',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769516844/WhatsApp_Image_2026-01-27_at_10.22.18_5_hjbq70.jpg'
  },
  {
    id: 'bod-1',
    nombre: 'Boda, miradas cómplices',
    collection: 'bodas',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769516844/WhatsApp_Image_2026-01-27_at_10.22.18_4_lh3v5n.jpg'
  },
  {
    id: 'bod-1',
    nombre: 'Boda, sentiminetos puros',
    collection: 'bodas',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769516844/WhatsApp_Image_2026-01-27_at_10.22.18_3_l4pqez.jpg'
  },
  {
    id: 'bod-1',
    nombre: 'Boda en familia',
    collection: 'bodas',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769516843/WhatsApp_Image_2026-01-27_at_10.22.18_1_wxebhr.jpg'
  },
  {
    id: 'bod-1',
    nombre: 'Boda, el anillo',
    collection: 'bodas',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769516843/WhatsApp_Image_2026-01-27_at_10.22.17_9_gcmkyz.jpg'
  },
  {
    id: 'bod-1',
    nombre: 'Boda, mascota incluida',
    collection: 'bodas',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769516843/WhatsApp_Image_2026-01-27_at_10.22.17_7_lrshvm.jpg'
  },
  {
    id: 'bod-1',
    nombre: 'Boda, abrazo eterno',
    collection: 'bodas',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769516843/WhatsApp_Image_2026-01-27_at_10.22.17_8_vbczlm.jpg'
  },
  {
    id: 'bod-1',
    nombre: 'Boda, ceremonia al aire libre',
    collection: 'bodas',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769516841/WhatsApp_Image_2026-01-27_at_10.22.18_eeeoig.jpg'
  },
  {
    id: 'viaj-1',
    nombre: 'Londres, puente de Londres',
    collection: 'viajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769600383/WhatsApp_Image_2026-01-28_at_12.38.38_3_qo9ys4.jpg'
  },
  {
    id: 'viaj-1',
    nombre: 'Londres, Big Ben',
    collection: 'viajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769600376/WhatsApp_Image_2026-01-28_at_12.38.38_2_ggkhq3.jpg'
  },
  {
    id: 'viaj-1',
    nombre: 'Paris, Torre Eiffel',
    collection: 'viajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769600375/WhatsApp_Image_2026-01-28_at_12.38.39_5_aza2ag.jpg'
  },
  {
    id: 'viaj-1',
    nombre: 'Suiza, Alpes',
    collection: 'viajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769600375/WhatsApp_Image_2026-01-28_at_12.38.37_2_rhd5zd.jpg'
  },
  {
    id: 'viaj-1',
    nombre: 'Nueva York',
    collection: 'viajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769600375/WhatsApp_Image_2026-01-28_at_12.38.39_odeis7.jpg'
  },
  {
    id: 'viaj-1',
    nombre: 'Londres, cabina roja',
    collection: 'viajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769600376/WhatsApp_Image_2026-01-28_at_12.38.38_1_yvqzoa.jpg'
  },
  {
    id: 'viaj-1',
    nombre: 'Estatua de la Libertad',
    collection: 'viajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769600375/WhatsApp_Image_2026-01-28_at_12.38.38_7_wcsegk.jpg'
  },
  {
    id: 'viaj-1',
    nombre: 'Cataratas del Niágara',
    collection: 'viajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769600376/WhatsApp_Image_2026-01-28_at_12.38.37_nijizf.jpg'
  },
  {
    id: 'viaj-1',
    nombre: 'Machupichu',
    collection: 'viajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769600375/WhatsApp_Image_2026-01-28_at_12.38.39_4_cyefok.jpg'
  },
  {
    id: 'viaj-1',
    nombre: 'Puente de Brooklyn',
    collection: 'viajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769600374/WhatsApp_Image_2026-01-28_at_12.38.38_6_r7luwn.jpg'
  },
  {
    id: 'viaj-1',
    nombre: 'Venecia, góndola',
    collection: 'viajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769600374/WhatsApp_Image_2026-01-28_at_12.38.38_5_gpl6uh.jpg'
  },
  {
    id: 'viaj-1',
    nombre: 'Paseo en París',
    collection: 'viajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769600375/WhatsApp_Image_2026-01-28_at_12.38.39_6_ia1v7l.jpg'
  },
  {
    id: 'viaj-1',
    nombre: 'Roma, Coliseo',
    collection: 'viajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769600374/WhatsApp_Image_2026-01-28_at_12.38.39_3_it0129.jpg'
  },
  {
    id: 'viaj-1',
    nombre: 'praga',
    collection: 'viajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769600374/WhatsApp_Image_2026-01-28_at_12.38.38_4_sleyey.jpg'
  },
  {
    id: 'viaj-1',
    nombre: 'Grecia, Santorini',
    collection: 'viajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769600374/WhatsApp_Image_2026-01-28_at_12.38.39_2_z39uad.jpg'
  },
  {
    id: 'viaj-1',
    nombre: 'Brasil, Cristo Redentor',
    collection: 'viajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769600376/WhatsApp_Image_2026-01-28_at_12.38.37_3_oakpmn.jpg'
  },
  {
    id: 'viaj-1',
    nombre: 'Grecia, Partenón',
    collection: 'viajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769600375/WhatsApp_Image_2026-01-28_at_12.38.39_1_gooclc.jpg'
  },
  {
    id: 'viaj-1',
    nombre: 'Holanda',
    collection: 'viajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769600375/WhatsApp_Image_2026-01-28_at_12.38.37_4_o4llbt.jpg'
  },
  {
    id: 'paisaje-1',
    nombre: 'Mutterhorn and Lake, Suiza',
    collection: 'paisajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1770213356/file_000000008e7871f5963a25bca4b24c1c_nj9mu9.png'
  },
    {
    id: 'paisaje-2',
    nombre: 'Lauterbrunnen, Suiza',
    collection: 'paisajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1770213356/file_00000000d44871f5adc9b9e61777d8d6_luvnhw.png'
  },
    {
    id: 'paisaje-3',
    nombre: 'Mutterhorn Zermatt, Suiza',
    collection: 'paisajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1770213356/file_000000006f28722f8134b730b2438bd1_1_wj2mev.png'
  },
    {
    id: 'paisaje-4',
    nombre: 'Seceda Dolomitas, Italia',
    collection: 'paisajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1770213356/file_000000007004722f91e625ce4a3baf85_y9hhkf.png'
  },
    {
    id: 'paisaje-5',
    nombre: 'Lucerne, Suiza',
    collection: 'paisajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1770213356/file_000000008094720c97c3b5c50975605c_nnqk08.png'
  },
    {
    id: 'paisaje-6',
    nombre: 'Interlaken, Suiza',
    collection: 'paisajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1770213356/file_00000000decc720c8a60584746a6e34c_un8p7q.png'
  },
    {
    id: 'paisaje-7',
    nombre: 'Lake Lucerne, Suiza',
    collection: 'paisajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1770213356/file_00000000a34c720c957722eeb44a3f75_gsc0na.png'
  },
    {
    id: 'paisaje-8',
    nombre: 'Grindelwald, Suiza',
    collection: 'paisajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769633027/litum3d/reviews/vol5jmjmby7hx0vaf4lp.jpg'
  },
    {
    id: 'paisaje-9',
    nombre: 'Cime di Lavaredo, Dolomitas',
    collection: 'paisajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1770213355/file_000000006090722f94cda82b1a8c051b_ki7kc7.png'
  },
    {
    id: 'paisaje-10',
    nombre: 'Lago di Braies, Dolomitas',
    collection: 'paisajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1770213354/file_00000000cab0720ca6451e42e988e061_cfxhbf.png'
  },
    {
    id: 'paisaje-11',
    nombre: 'Lauterbrunnen Cascade, Suiza',
    collection: 'paisajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1770213354/file_00000000fd30720ca2de1bfb14130934_nmpigj.png'
  },
      {
    id: 'paisaje-11',
    nombre: 'Alpe di Siusi, Dolomitas',
    collection: 'paisajes',
    imagen: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1770213354/file_00000000ea3471fdb34287f1b618e7d1_ymjuou.png'
  },
  {
    id: 'anime-1',
    nombre: 'Anime',
    collection: 'anime',
    imagen: '',
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

