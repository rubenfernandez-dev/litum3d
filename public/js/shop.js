// ============================================
// Shop Page - Carga y Filtrado de Productos
// ============================================
// La lógica del modal de personalización (customizationState, pricingConfig,
// openCustomization, cálculo de precio, extras, confirmCustomization, etc.)
// vive en public/js/customization.js, compartida con Home/Destacados -- no
// duplicarla aquí. Este archivo solo gestiona el catálogo/filtros propios
// de /shop.

let allShopProducts = [];

/**
 * Cargar todos los productos desde la API
 */
async function loadShopProducts() {
  const container = document.getElementById('shop-products');
  try {
    // Detectar idioma de la página
    const lang = document.documentElement.lang || 'es';
    const res = await fetch(`/api/productos?lang=${lang}`);
    if (!res.ok) throw new Error('Error al obtener productos');

    allShopProducts = await res.json() || [];
    // customization.js busca el producto a abrir en esta lista (ver
    // openCustomization/setCustomizationProducts).
    setCustomizationProducts(allShopProducts);

    if (allShopProducts.length === 0) {
      container.innerHTML = '<p style="grid-column: 1/-1; text-align: center; padding: 40px; color: #e0ad61;">No hay productos disponibles en este momento.</p>';
      return;
    }

    renderShopProducts(allShopProducts);
  } catch (err) {
    console.error(err);
    container.innerHTML = '<p style="grid-column: 1/-1; color: #ff6b6b; text-align: center; padding: 40px;">Error al cargar el catálogo de productos.</p>';
  }
}

/**
 * Renderizar productos en la tienda
 */
function renderShopProducts(products) {
  const container = document.getElementById('shop-products');

  if (products.length === 0) {
    container.innerHTML = '<p style="grid-column: 1/-1; text-align: center; padding: 40px; color: #e0ad61;">No se encontraron productos con los filtros seleccionados.</p>';
    return;
  }

  container.innerHTML = products.map(p => {
    // Resolver URL de la imagen
    let imageUrl = '';
    if (p.imagen) {
      if (p.imagen.startsWith('http') || p.imagen.startsWith('/')) {
        imageUrl = p.imagen;
      } else {
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
        <p class="product-desc">${escapeHtml(p.descripcion || 'Litofanía premium personalizada')}</p>
        <div class="product-footer">
          <span class="product-price">${parseFloat(p.precio).toFixed(2)} €</span>
          <span class="product-stock">${p.stock > 0 ? '✓ Disponible' : 'Agotado'}</span>
        </div>
        <button class="product-buy-btn" onclick="openCustomization(${p.id})" ${p.stock > 0 ? '' : 'disabled'}>
          ${p.stock > 0 ? '✨ Personalizar mi litofanía' : 'Agotado'}
        </button>
      </div>
    </div>
    `;
  }).join('');
}

/**
 * Aplicar filtros a los productos
 */
function applyFilters() {
  const shapeFilter = document.getElementById('filter-shape')?.value || '';
  const baseFilter = document.getElementById('filter-base')?.value || '';

  let filtered = allShopProducts;

  // Filtrar por forma
  if (shapeFilter) {
    filtered = filtered.filter(p =>
      p.forma && p.forma.toLowerCase().includes(shapeFilter.toLowerCase())
    );
  }

  // Filtrar por base
  if (baseFilter) {
    filtered = filtered.filter(p =>
      p.base && p.base.toLowerCase().includes(baseFilter.toLowerCase())
    );
  }

  renderShopProducts(filtered);
}

/**
 * Limpiar filtros
 */
function clearFilters() {
  document.getElementById('filter-shape').value = '';
  document.getElementById('filter-base').value = '';
  renderShopProducts(allShopProducts);
}

// Cargar productos al inicializar la página
document.addEventListener('DOMContentLoaded', () => {
  loadShopProducts();
  loadPricingConfig();
  document.getElementById('cart-badge').textContent = getCartCount();
});
