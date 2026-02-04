// ============================================
// Shop Page - Carga y Filtrado de Productos
// ============================================

let allShopProducts = [];
let customizationState = {
  product: null,
  models: [],
  selectedModelId: null,
  selectedModelName: null,
  selectedModelPriceDelta: 0,
  files: []
};

/**
 * Cargar todos los productos desde la API
 */
async function loadShopProducts() {
  const container = document.getElementById('shop-products');
  try {
    const res = await fetch('/api/productos');
    if (!res.ok) throw new Error('Error al obtener productos');

    allShopProducts = await res.json() || [];

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
          <span class="product-price">€${parseFloat(p.precio).toFixed(2)}</span>
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

/**
 * Abrir modal de personalización
 */
async function openCustomization(productId) {
  const product = allShopProducts.find(p => p.id === productId);
  if (!product) return;

  customizationState = {
    product,
    models: [],
    selectedModelId: null,
    selectedModelName: null,
    selectedModelPriceDelta: 0,
    files: []
  };

  // Actualizar título del modal
  document.getElementById('custom-modal-title').textContent = `Personalizar: ${product.nombre}`;

  // Cargar modelos disponibles
  await loadModelsForProduct(product.id);

  // Mostrar modal
  document.getElementById('customization-modal').classList.add('show');
}

/**
 * Cargar modelos disponibles para un producto
 */
async function loadModelsForProduct(productId) {
  try {
    const res = await fetch(`/api/productos/${productId}/variant-types`);
    if (!res.ok) throw new Error('Error al obtener variantes');

    const variantTypes = await res.json();
    const modelsContainer = document.getElementById('custom-models');

    if (!variantTypes || variantTypes.length === 0) {
      modelsContainer.innerHTML = '<p style="opacity: 0.7;">No hay opciones de modelo disponibles.</p>';
      return;
    }

    // Buscar el tipo de variante de modelo (usualmente por nombre)
    const modelVariant = variantTypes.find(v =>
      v.nombre.toLowerCase().includes('model') ||
      v.nombre.toLowerCase().includes('forma') ||
      v.nombre.toLowerCase().includes('shape')
    );

    if (modelVariant && modelVariant.options && modelVariant.options.length > 0) {
      customizationState.models = modelVariant.options;
      modelsContainer.innerHTML = modelVariant.options.map(opt => `
        <label class="custom-model-option">
          <input type="radio" name="model" value="${opt.id}" onchange="selectModel(${opt.id}, '${escapeHtml(opt.nombre)}', ${opt.price_delta || 0})">
          <span>${escapeHtml(opt.nombre)} ${opt.price_delta ? `(+€${parseFloat(opt.price_delta).toFixed(2)})` : ''}</span>
        </label>
      `).join('');
    } else {
      modelsContainer.innerHTML = '<p style="opacity: 0.7;">No hay opciones de modelo disponibles.</p>';
    }

    // Cargar variantes adicionales
    loadVariantTypes(productId);
  } catch (err) {
    console.error(err);
    document.getElementById('custom-models').innerHTML = '<p style="color: #ff6b6b;">Error al cargar opciones.</p>';
  }
}

/**
 * Seleccionar modelo
 */
function selectModel(modelId, modelName, priceDelta) {
  customizationState.selectedModelId = modelId;
  customizationState.selectedModelName = modelName;
  customizationState.selectedModelPriceDelta = priceDelta || 0;
  updateCustomizationPrice();
}

/**
 * Cargar tipos de variantes
 */
async function loadVariantTypes(productId) {
  try {
    const res = await fetch(`/api/productos/${productId}/variant-types`);
    if (!res.ok) return;

    const variantTypes = await res.json();
    const container = document.querySelector('[data-variants-section] .variant-types-container');

    if (!container || !variantTypes || variantTypes.length === 0) return;

    // Filtrar solo tipos de variante que NO sean modelo
    const otherVariants = variantTypes.filter(v =>
      !v.nombre.toLowerCase().includes('model') &&
      !v.nombre.toLowerCase().includes('forma') &&
      !v.nombre.toLowerCase().includes('shape')
    );

    if (otherVariants.length === 0) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = otherVariants.map(variantType => `
      <div class="variant-type-group">
        <label>${variantType.nombre}</label>
        <select onchange="onVariantChange()">
          <option value="">Selecciona ${variantType.nombre.toLowerCase()}</option>
          ${variantType.options.map(opt => `
            <option value="${opt.id}" data-price="${opt.price_delta || 0}">
              ${escapeHtml(opt.nombre)} ${opt.price_delta ? `(+€${parseFloat(opt.price_delta).toFixed(2)})` : ''}
            </option>
          `).join('')}
        </select>
      </div>
    `).join('');
  } catch (err) {
    console.error(err);
  }
}

/**
 * Actualizar precio de personalización
 */
function updateCustomizationPrice() {
  const basePrice = customizationState.product?.precio || 0;
  const modelDelta = customizationState.selectedModelPriceDelta || 0;

  // Calcular extras
  let extrasCost = 0;
  if (document.getElementById('extra-upscale')?.checked) extrasCost += 5;
  if (document.getElementById('extra-qr')?.checked) extrasCost += 5;
  if (document.getElementById('extra-adapter')?.checked) extrasCost += 4;

  // Calcular precio con variantes
  let variantsCost = 0;
  document.querySelectorAll('[data-variants-section] select').forEach(select => {
    const selectedOption = select.querySelector('option:checked');
    if (selectedOption && selectedOption.value) {
      variantsCost += parseFloat(selectedOption.dataset.price || 0);
    }
  });

  const totalPrice = basePrice + modelDelta + extrasCost + variantsCost;

  document.querySelector('[data-variant-price]').textContent = `€${parseFloat(totalPrice).toFixed(2)}`;
  document.getElementById('custom-base-price').textContent = parseFloat(basePrice).toFixed(2);
  document.getElementById('custom-total').textContent = parseFloat(totalPrice).toFixed(2);
}

/**
 * Cuando cambia una variante
 */
function onVariantChange() {
  updateCustomizationPrice();
}

/**
 * Cuando cambia un extra
 */
function onExtraChange() {
  const qrCheckbox = document.getElementById('extra-qr');
  const qrMessage = document.getElementById('extra-qr-message');

  if (qrCheckbox?.checked) {
    qrMessage.disabled = false;
  } else {
    qrMessage.disabled = true;
    qrMessage.value = '';
  }

  updateCustomizationPrice();
}

/**
 * Manejar selección de archivos
 */
function handleFileSelection(input) {
  const fileList = document.getElementById('custom-file-list');
  const files = Array.from(input.files || []);

  if (files.length > 4) {
    alert('Máximo 4 archivos permitidos');
    return;
  }

  customizationState.files = files;

  if (files.length === 0) {
    fileList.innerHTML = '';
    return;
  }

  fileList.innerHTML = files.map((file, idx) => `
    <div class="custom-file-chip">
      ${escapeHtml(file.name)} <span onclick="removeFile(${idx})" style="cursor: pointer; margin-left: 6px;">✕</span>
    </div>
  `).join('');
}

/**
 * Remover archivo
 */
function removeFile(index) {
  const input = document.getElementById('custom-files');
  customizationState.files.splice(index, 1);

  const dataTransfer = new DataTransfer();
  customizationState.files.forEach(file => dataTransfer.items.add(file));
  input.files = dataTransfer.files;

  handleFileSelection(input);
}

/**
 * Confirmar personalización y agregar al carrito
 */
async function confirmCustomization() {
  const files = customizationState.files;
  const notes = document.getElementById('custom-notes')?.value || '';

  if (files.length === 0) {
    alert('Por favor sube al menos una foto');
    return;
  }

  if (!customizationState.selectedModelId) {
    alert('Por favor selecciona un modelo');
    return;
  }

  try {
    // Crear FormData para envío de archivos
    const formData = new FormData();
    files.forEach(file => formData.append('files', file));
    formData.append('product_id', customizationState.product.id);
    formData.append('model_id', customizationState.selectedModelId);
    formData.append('notes', notes);

    // Recopilar variantes seleccionadas
    const selectedVariants = {};
    document.querySelectorAll('[data-variants-section] select').forEach(select => {
      if (select.value) {
        const label = select.previousElementSibling?.textContent || 'variant';
        selectedVariants[label] = select.value;
      }
    });
    formData.append('variants', JSON.stringify(selectedVariants));

    // Extras
    formData.append('extra_upscale', document.getElementById('extra-upscale')?.checked ? '1' : '0');
    formData.append('extra_qr', document.getElementById('extra-qr')?.checked ? '1' : '0');
    formData.append('extra_qr_message', document.getElementById('extra-qr-message')?.value || '');
    formData.append('extra_adapter', document.getElementById('extra-adapter')?.checked ? '1' : '0');

    // Subir archivos y obtener IDs
    const uploadRes = await fetch('/api/pedidos/upload-files', {
      method: 'POST',
      body: formData
    });

    if (!uploadRes.ok) {
      const errorData = await uploadRes.json();
      alert('Error al subir archivos: ' + (errorData.message || 'Error desconocido'));
      return;
    }

    const uploadData = await uploadRes.json();

    // Crear item del carrito
    const cartItem = {
      product_id: customizationState.product.id,
      product_name: customizationState.product.nombre,
      product_price: parseFloat(customizationState.product.precio),
      quantity: 1,
      model_id: customizationState.selectedModelId,
      model_name: customizationState.selectedModelName,
      model_price_delta: customizationState.selectedModelPriceDelta,
      uploaded_files: uploadData.files || [],
      notes: notes,
      variants: selectedVariants,
      extras: {
        upscale: document.getElementById('extra-upscale')?.checked ? true : false,
        qr: document.getElementById('extra-qr')?.checked ? true : false,
        qr_message: document.getElementById('extra-qr-message')?.value || '',
        adapter: document.getElementById('extra-adapter')?.checked ? true : false
      }
    };

    // Agregar al carrito
    addToCart(cartItem);

    // Cerrar modal
    closeCustomization();

    // Mostrar notificación
    showNotification('✨ Producto añadido al carrito', 'success');
  } catch (err) {
    console.error(err);
    alert('Error al procesar la personalización');
  }
}

/**
 * Cerrar modal
 */
function closeCustomization() {
  document.getElementById('customization-modal').classList.remove('show');
  document.getElementById('custom-notes').value = '';
  document.getElementById('custom-files').value = '';
  document.getElementById('custom-file-list').innerHTML = '';
  customizationState = {
    product: null,
    models: [],
    selectedModelId: null,
    selectedModelName: null,
    selectedModelPriceDelta: 0,
    files: []
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

function showNotification(message, type = 'info') {
  // Crear elemento de notificación
  const notif = document.createElement('div');
  notif.style.cssText = `
    position: fixed;
    bottom: 100px;
    right: 20px;
    padding: 16px 24px;
    background: ${type === 'success' ? '#25D366' : '#2196F3'};
    color: white;
    border-radius: 8px;
    z-index: 999;
    animation: slideIn 0.3s ease;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  `;
  notif.textContent = message;
  document.body.appendChild(notif);

  setTimeout(() => notif.remove(), 3000);
}

// Cargar productos al inicializar la página
document.addEventListener('DOMContentLoaded', () => {
  loadShopProducts();
  document.getElementById('cart-badge').textContent = getCartCount();
});
