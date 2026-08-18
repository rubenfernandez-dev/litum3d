// ============================================
// Shop Page - Carga y Filtrado de Productos
// ============================================

let allShopProducts = [];
// Única fuente de precios de extras: GET /api/pricing-config (servidor).
// null mientras no ha cargado o si la carga falló — nunca hay un fallback
// hardcodeado 5/5/4 en su lugar.
let pricingConfig = null;
let customizationState = {
  product: null,
  models: [],
  selectedModelId: null,
  selectedModelName: null,
  selectedModelPriceDelta: 0,
  files: []
};

/**
 * Carga la configuración pública de pricing (moneda + precios de extras).
 * Se llama una vez al cargar la página; si falla, deja pricingConfig=null y
 * deshabilita los extras en la UI en vez de calcular con un precio
 * adivinado o desincronizado.
 */
async function loadPricingConfig() {
  try {
    const res = await fetch('/api/pricing-config');
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'No se pudo cargar la configuración de precios');
    pricingConfig = data;
  } catch (err) {
    console.error('Error cargando /api/pricing-config:', err);
    pricingConfig = null;
  }
  applyPricingConfigToExtrasUI();
}

/**
 * Precio (en EUR, para mostrar) de un extra según config servidor. Solo se
 * usa cuando pricingConfig existe; si no, los checkboxes quedan deshabilitados.
 */
function getExtraPrice(key) {
  return pricingConfig?.extras?.[key]?.amount || 0;
}

/**
 * Si la configuración de precios no está disponible, deshabilita los extras
 * en vez de dejarlos seleccionables con un precio no determinado.
 */
function applyPricingConfigToExtrasUI() {
  const available = !!pricingConfig;
  ['extra-upscale', 'extra-qr', 'extra-adapter'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = !available;
    if (!available) el.checked = false;
  });
  const qrMsgInput = document.getElementById('extra-qr-message');
  if (qrMsgInput && !available) {
    qrMsgInput.disabled = true;
    qrMsgInput.value = '';
  }
  if (!available && typeof updateCustomizationPrice === 'function' && customizationState.product) {
    updateCustomizationPrice();
  }
}

/**
 * Combina el "modelo" (en realidad un product_variant_options.id, ver
 * loadModelsForProduct) con el resto de opciones de variante seleccionadas
 * en una única lista de IDs, sin inventar nada y sin huecos falsy.
 */
function buildVariantOptionIds(selectedModelOptionId, otherOptionValues) {
  const ids = [];
  if (selectedModelOptionId) ids.push(selectedModelOptionId);
  (otherOptionValues || []).forEach(v => { if (v) ids.push(v); });
  return ids;
}

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

  // Precio inicial (sin modelo/extras adicionales todavía): antes de esta
  // llamada, el modal mostraba el placeholder estático "€0.00" del HTML
  // hasta la primera interacción (selectModel/onExtraChange), porque
  // ninguna función pintaba el precio en la apertura. Misma función que
  // usan las interacciones posteriores, sin fórmula nueva.
  updateCustomizationPrice();

  // Actualizar título del modal
  document.getElementById('custom-modal-title').textContent = `Personalizar: ${product.nombre}`;

  // Refleja si /api/pricing-config está disponible (puede haberse resuelto
  // ya, o seguir en curso si el modal se abre muy pronto tras cargar la página).
  applyPricingConfigToExtrasUI();

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
          <span>${escapeHtml(opt.nombre)} ${opt.price_delta ? `(+${parseFloat(opt.price_delta).toFixed(2)} €)` : ''}</span>
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
              ${escapeHtml(opt.nombre)} ${opt.price_delta ? `(+${parseFloat(opt.price_delta).toFixed(2)} €)` : ''}
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
  // customizationState.product.precio viene de /api/productos como string
  // (columna DECIMAL vía mysql2, p.ej. "49.95"). Sin parseFloat, el "+" de
  // abajo concatena en vez de sumar ("49.95"+15+5 = "49.951550") y el precio
  // mostrado queda anclado al precio base pase lo que pase se seleccione.
  const basePrice = parseFloat(customizationState.product?.precio || 0);
  const modelDelta = customizationState.selectedModelPriceDelta || 0;

  // Calcular extras. Precios desde /api/pricing-config (getExtraPrice),
  // nunca hardcodeados; si no hay config disponible, los checkboxes están
  // deshabilitados (ver applyPricingConfigToExtrasUI) y esto suma 0.
  let extrasCost = 0;
  if (document.getElementById('extra-upscale')?.checked) extrasCost += getExtraPrice('upscale');
  if (document.getElementById('extra-qr')?.checked) extrasCost += getExtraPrice('qr');
  if (document.getElementById('extra-adapter')?.checked) extrasCost += getExtraPrice('adapter');

  // Calcular precio con variantes
  let variantsCost = 0;
  document.querySelectorAll('[data-variants-section] select').forEach(select => {
    const selectedOption = select.querySelector('option:checked');
    if (selectedOption && selectedOption.value) {
      variantsCost += parseFloat(selectedOption.dataset.price || 0);
    }
  });

  const totalPrice = basePrice + modelDelta + extrasCost + variantsCost;

  document.querySelector('[data-variant-price]').textContent = `${parseFloat(totalPrice).toFixed(2)} €`;
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

  // No permitir confirmar una personalización con un extra seleccionado si
  // su precio no se pudo determinar de forma segura (config no disponible).
  const extrasPreview = getExtrasFromUI();
  if (!pricingConfig && (extrasPreview.upscale || extrasPreview.qr || extrasPreview.adapter)) {
    alert('No se pudo determinar el precio de los extras seleccionados. Recarga la página e inténtalo de nuevo.');
    return;
  }

  try {
    const extras = getExtrasFromUI();
    const variantDelta = getVariantsPriceDelta();

    // Crear FormData para envío de archivos
    const formData = new FormData();
    files.forEach(file => formData.append('images', file));
    formData.append('product_id', customizationState.product.id);
    formData.append('model_id', customizationState.selectedModelId);
    formData.append('notes', notes);

    // Recopilar variantes seleccionadas (resto de tipos, distintos del "modelo")
    const selectedVariants = {};
    const otherVariantValues = [];
    document.querySelectorAll('[data-variants-section] select').forEach(select => {
      if (select.value) {
        const label = select.previousElementSibling?.textContent || 'variant';
        selectedVariants[label] = select.value;
        otherVariantValues.push(select.value);
      }
    });
    formData.append('variants', JSON.stringify(selectedVariants));

    // variantOptionIds: en shop.js el "modelo" (selectedModelId) es en
    // realidad el ID de una product_variant_options (el tipo cuyo nombre
    // contiene "model"/"forma"/"shape", ver loadModelsForProduct), NO un
    // product_models.id real. Por eso viaja en variantOptionIds y NO en
    // modelId — no se inventa un modelId de product_models que no existe.
    const variantOptionIds = buildVariantOptionIds(customizationState.selectedModelId, otherVariantValues);

    // Extras
    formData.append('extra_upscale', document.getElementById('extra-upscale')?.checked ? '1' : '0');
    formData.append('extra_qr', document.getElementById('extra-qr')?.checked ? '1' : '0');
    formData.append('extra_qr_message', document.getElementById('extra-qr-message')?.value || '');
    formData.append('extra_adapter', document.getElementById('extra-adapter')?.checked ? '1' : '0');

    // Subir archivos y obtener IDs
    const uploadRes = await fetch('/api/uploads/custom', {
      method: 'POST',
      body: formData
    });

    if (!uploadRes.ok) {
      let errorMsg = 'Error desconocido';
      try {
        const errorData = await uploadRes.json();
        errorMsg = errorData.message || errorData.error || errorMsg;
      } catch (e) {
        const text = await uploadRes.text();
        if (text) errorMsg = text;
      }
      alert('Error al subir archivos: ' + errorMsg);
      return;
    }

    const uploadData = await uploadRes.json();

    // Agregar al carrito
    addToCart(
      customizationState.product.id,
      customizationState.product.nombre,
      customizationState.product.precio,
      {
        // modelId se deja explícitamente null: en shop.js no existe una
        // selección real de product_models, solo de product_variant_options
        // (ver variantOptionIds más arriba). modelName se conserva solo
        // como etiqueta de presentación.
        modelId: null,
        modelName: customizationState.selectedModelName,
        // Legacy pricing field — remove after canonical checkout cutover
        priceDelta: (parseFloat(customizationState.selectedModelPriceDelta || 0) + variantDelta),
        variantOptionIds,
        images: uploadData.files || [],
        notes: buildNotesWithExtras(notes, extras),
        extras: extras
      }
    );

    // Cerrar modal
    closeCustomization();

    // Mostrar notificación
    showNotification('✨ Producto añadido al carrito', 'success');
  } catch (err) {
    console.error(err);
    alert('Error al procesar la personalización');
  }
}

function getExtrasFromUI() {
  const upscale = document.getElementById('extra-upscale')?.checked || false;
  const qr = document.getElementById('extra-qr')?.checked || false;
  const adapter = document.getElementById('extra-adapter')?.checked || false;
  const qrMessage = document.getElementById('extra-qr-message')?.value || '';

  // Legacy pricing field — remove after canonical checkout cutover.
  const extrasTotal = (upscale ? getExtraPrice('upscale') : 0) + (qr ? getExtraPrice('qr') : 0) + (adapter ? getExtraPrice('adapter') : 0);
  return { upscale, qr, qrMessage, adapter, extrasTotal, currency: 'EUR' };
}

function getVariantsPriceDelta() {
  let variantsCost = 0;
  document.querySelectorAll('[data-variants-section] select').forEach(select => {
    const selectedOption = select.querySelector('option:checked');
    if (selectedOption && selectedOption.value) {
      variantsCost += parseFloat(selectedOption.dataset.price || 0);
    }
  });
  return variantsCost;
}

// Texto de presentación para las notas del pedido (personalizacion_notas),
// no una fuente de cálculo. Los importes se leen de pricingConfig para no
// mantener una segunda copia manual de 5/5/4 en un string.
function buildNotesWithExtras(notes, extras) {
  const parts = [];
  if (notes && notes.trim()) parts.push(notes.trim());
  const extrasList = [];
  if (extras?.upscale) extrasList.push(`Upscale +${getExtraPrice('upscale')} ${extras.currency}`);
  if (extras?.qr) extrasList.push(`QR +${getExtraPrice('qr')} ${extras.currency}${extras.qrMessage ? `: ${extras.qrMessage}` : ''}`);
  if (extras?.adapter) extrasList.push(`Adaptador USB +${getExtraPrice('adapter')} ${extras.currency}`);
  if (extrasList.length) parts.push(`Extras: ${extrasList.join(' · ')}`);
  return parts.join(' | ');
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
  loadPricingConfig();
  document.getElementById('cart-badge').textContent = getCartCount();
});
