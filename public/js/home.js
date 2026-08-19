// Fetch and display featured products
// La lógica del modal de personalización (customizationState, pricingConfig,
// openCustomization, cálculo de precio, extras, confirmCustomization, etc.)
// vive en public/js/customization.js, compartida con /shop -- no duplicarla
// aquí. Este archivo solo gestiona Destacados/FAQ/newsletter/reseñas,
// propios de la Home.
let featuredProductsCache = [];

async function loadFeaturedProducts() {
  const container = document.getElementById('featured-products');
  try {
    // Mismo mecanismo de idioma que shop.js#loadShopProducts: el <html lang="...">
    // de la propia página (index-de.html/index-fr.html) decide qué traducción
    // pide la API -- Home no tenía esto y siempre mostraba nombre/descripcion
    // en español, aunque el producto ya tuviera nombre_de/nombre_fr en BD.
    const lang = document.documentElement.lang || 'es';
    const res = await fetch(`/api/productos?lang=${lang}`);
    if (!res.ok) throw new Error('Error al obtener productos');

    let products = await res.json();
    featuredProductsCache = products || [];
    // customization.js busca el producto a abrir en esta lista (ver
    // openCustomization/setCustomizationProducts) -- se sincroniza con la
    // lista COMPLETA devuelta por la API, no con el slice(0, 4) de abajo,
    // que solo decide qué tarjetas se muestran.
    setCustomizationProducts(featuredProductsCache);

    if (!products || products.length === 0) {
      container.innerHTML = '<p style="grid-column: 1/-1; text-align: center;">No hay productos disponibles.</p>';
      return;
    }

    // Show only first 4
    products = products.slice(0, 4);

    container.innerHTML = products.map(p => {
      // Resolver la URL de la imagen
      let imageUrl = '';
      if (p.imagen) {
        // Si la imagen es una URL completa (empieza con http o /)
        if (p.imagen.startsWith('http') || p.imagen.startsWith('/')) {
          imageUrl = p.imagen;
        } else {
          // Si es solo el nombre del archivo, añadir la ruta
          imageUrl = `/img/productos/${p.imagen}`;
        }
      }

      return `
      <div class="product-card">
        <div class="product-image">
          ${imageUrl
            ? `<img src="${imageUrl}" alt="${escapeHtml(p.nombre)}" onerror="this.onerror=null; this.parentElement.innerHTML='${getEmojiForProduct(p.nombre)}';">`
            : getEmojiForProduct(p.nombre)
          }
        </div>
        <div class="product-content">
          <h3 class="product-name">${escapeHtml(p.nombre)}</h3>
          <p class="product-desc">${escapeHtml(p.descripcion || 'Litofanía premium con acabado profesional')}</p>
          <div class="product-footer">
            <span class="product-price">${parseFloat(p.precio).toFixed(2)} €</span>
            <span class="product-stock">${p.stock > 0 ? '✓ Stock' : 'Agotado'}</span>
          </div>
          <button class="product-buy-btn" onclick="openCustomization(${p.id})" ${p.stock > 0 ? '' : 'disabled'}>
            ${p.stock > 0 ? '✨ Personalizar y Comprar' : 'Agotado'}
          </button>
        </div>
      </div>
    `;
    }).join('');
  } catch (err) {
    console.error(err);
    container.innerHTML = '<p style="grid-column: 1/-1; color: #ff6b6b; text-align: center;">Error al cargar productos.</p>';
  }
}

// Load on page ready
document.addEventListener('DOMContentLoaded', () => {
  loadFeaturedProducts();
  loadPricingConfig();
  const modal = document.getElementById('customization-modal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target.id === 'customization-modal') {
        closeCustomization();
      }
    });
  }
});

// FAQ Toggle function
function toggleFAQ(button) {
  const faqItem = button.parentElement;
  const isActive = faqItem.classList.contains('active');

  // Close all FAQ items
  document.querySelectorAll('.faq-item.active').forEach(item => {
    item.classList.remove('active');
  });

  // Open the clicked item if it wasn't active
  if (!isActive) {
    faqItem.classList.add('active');
  }
}

// Newsletter subscription
function subscribeNewsletter(event) {
  event.preventDefault();
  const form = event.target;
  const email = form.querySelector('input[type="email"]').value;
  const button = form.querySelector('button');

  const originalText = button.textContent;
  button.textContent = '⏳ Suscribiendo...';
  button.disabled = true;

  // Store in localStorage (or send to backend if you add an endpoint)
  const subscribers = JSON.parse(localStorage.getItem('newsletter_subscribers') || '[]');
  if (!subscribers.includes(email)) {
    subscribers.push(email);
    localStorage.setItem('newsletter_subscribers', JSON.stringify(subscribers));
  }

  setTimeout(() => {
    button.textContent = '✓ Suscrito!';
    button.style.background = 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)';

    setTimeout(() => {
      form.reset();
      button.textContent = originalText;
      button.style.background = '';
      button.disabled = false;
    }, 2000);
  }, 500);
}

// Cargar reseñas destacadas en la página de inicio
async function loadFeaturedReviews() {
  const container = document.getElementById('featured-reviews');

  try {
    const response = await fetch('/api/reviews');
    if (!response.ok) throw new Error('Error al cargar reseñas');

    const reviews = await response.json();

    if (!reviews || reviews.length === 0) {
      container.innerHTML = `
        <div style="text-align:center; padding:40px; grid-column: 1 / -1; opacity:0.7;">
          📭 Aún no hay reseñas. ¡Sé el primero en dejar una!
        </div>
      `;
      return;
    }

    // Mostrar de 3 a 5 reseñas (o menos si no hay suficientes)
    const reviewsToShow = reviews.slice(0, Math.min(5, reviews.length));

    container.innerHTML = reviewsToShow.map(review => {
      const stars = '⭐'.repeat(review.rating);
      const date = new Date(review.fecha_creacion).toLocaleDateString('es-ES', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });

      let imagesHtml = '';
      if (review.imagenes && review.imagenes.length > 0) {
        imagesHtml = `
          <div class="review-images">
            ${review.imagenes.slice(0, 2).map((img, idx) => `
              <img src="${img}"
                   alt="Foto ${idx + 1} de ${review.nombre}"
                   class="review-image"
                   style="width:100px; height:100px; object-fit:cover; border-radius:8px;"
                   onerror="console.log('Error cargando imagen:', '${img}')"
                   onclick="openImageModal('${img}')">
            `).join('')}
          </div>
        `;
      }

      return `
        <div class="review-card">
          <div class="review-content">
            <div class="review-info">
              <div style="font-weight: 600; color: #fff; margin-bottom: 0.3rem;">${review.nombre}</div>
              <div style="color: #ffd700; font-size: 0.9rem; letter-spacing: 0.1rem;">${stars}</div>
            </div>
            <div class="review-text">
              <div class="review-comment">${review.comentario.substring(0, 200)}${review.comentario.length > 200 ? '...' : ''}</div>
            </div>
            <div class="review-media">
              ${imagesHtml}
            </div>
          </div>
        </div>
      `;
    }).join('');
  } catch (error) {
    console.error('Error cargando reseñas:', error);
    container.innerHTML = `
      <div style="text-align:center; padding:40px; grid-column: 1 / -1; opacity:0.7;">
        ⚠️ Error al cargar reseñas
      </div>
    `;
  }
}

// Ejecutar cuando se carga la página
document.addEventListener('DOMContentLoaded', () => {
  loadFeaturedReviews();
});
