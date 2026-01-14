// Fetch and display featured products
let featuredProductsCache = [];
let customizationState = {
  product: null,
  models: [],
  selectedModelId: null,
  selectedModelName: null,
  selectedModelPriceDelta: 0,
  files: []
};

async function loadFeaturedProducts() {
  const container = document.getElementById('featured-products');
  try {
    const res = await fetch('/api/productos');
    if (!res.ok) throw new Error('Error al obtener productos');
    
    let products = await res.json();
    featuredProductsCache = products || [];
    
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
            <span class="product-price">€${parseFloat(p.precio).toFixed(2)}</span>
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

// Helper: escape HTML
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

// Helper: emoji por tipo de producto
function getEmojiForProduct(name) {
  if (name.toLowerCase().includes('dragon')) return '🐉';
  if (name.toLowerCase().includes('busto')) return '🗿';
  if (name.toLowerCase().includes('miniatura') || name.toLowerCase().includes('medieval')) return '⚔️';
  if (name.toLowerCase().includes('figura')) return '🎨';
  return '✨';
}

async function openCustomization(productId) {
  const product = featuredProductsCache.find(p => p.id === productId);
  if (!product) return;

  customizationState = {
    product,
    models: [],
    selectedModelId: null,
    selectedModelName: null,
    selectedModelPriceDelta: 0,
    files: [],
    selectedVariants: {}, // Añadir estado para variantes
    extras: {
      upscale: false,
      qr: false,
      qrMessage: '',
      adapter: false,
      extrasTotal: 0,
      currency: 'CHF'
    }
  };

  document.getElementById('custom-modal-title').textContent = `Personalizar: ${product.nombre}`;
  document.getElementById('custom-base-price').textContent = parseFloat(product.precio).toFixed(2);
  document.getElementById('custom-notes').value = '';
  document.getElementById('custom-files').value = '';
  document.getElementById('custom-file-list').innerHTML = '';

  // Cargar variantes y modelos
  await loadVariantsForProduct(productId);
  await loadModelsForProduct(productId);
  updateCustomTotal();
  document.getElementById('customization-modal').classList.add('show');
}

async function loadVariantsForProduct(productId) {
  try {
    console.log('📦 Cargando variantes para producto:', productId);
    const res = await fetch(`/api/productos/${productId}/variant-types`);
    if (!res.ok) {
      console.warn('No variant types found for this product');
      return;
    }
    const types = await res.json();
    console.log('✅ Variantes cargadas:', types);
    renderVariantsForm(types);
  } catch (err) {
    console.error('Error loading variant types:', err);
  }
}

function renderVariantsForm(variantTypes) {
  const variantsContainer = document.querySelector('[data-variants-section] .variant-types-container');
  if (!variantsContainer) {
    console.error('Variants container not found');
    return;
  }

  // Si no hay variantes, no mostrar nada
  if (!variantTypes || variantTypes.length === 0) {
    variantsContainer.innerHTML = '';
    return;
  }

  let html = '<h4 style="margin-bottom: 12px;">Selecciona las opciones de tu producto</h4>';

  // Crear selector para cada tipo de variante
  for (const variantType of variantTypes) {
    const required = variantType.is_required ? '(obligatorio)' : '(opcional)';
    html += `
      <div class="variant-type-group" style="margin-bottom: 12px;">
        <label style="display: block; margin-bottom: 6px; font-weight: 500;">${variantType.nombre} ${required}</label>
        <select 
          class="variant-select" 
          data-type-id="${variantType.id}" 
          data-required="${variantType.is_required}"
          style="width: 100%; padding: 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.06); color: var(--text-light);"
          ${variantType.is_required ? 'required' : ''}>
          <option value="">-- Selecciona ${variantType.nombre.toLowerCase()} --</option>
    `;

      // Opciones para este tipo de variante
      for (const option of variantType.options) {
        // Siempre mostrar stock de 100 disponibles
        const stockText = '(100 disponibles)';
        const priceDisplay = option.price_delta > 0 ? ` +€${option.price_delta.toFixed(2)}` : '';

        html += `
          <option 
            value="${option.id}" 
            data-price-delta="${option.price_delta}"
            data-stock="100">
            ${option.nombre}${priceDisplay} ${stockText}
          </option>
        `;
      }

      html += `</select></div>`;
    }

  variantsContainer.innerHTML = html;
  attachVariantListeners();
}

function attachVariantListeners() {
  document.querySelectorAll('.variant-select').forEach(select => {
    select.addEventListener('change', (e) => {
      const typeId = e.target.dataset.typeId;
      const optionId = e.target.value;

      if (optionId) {
        customizationState.selectedVariants[typeId] = optionId;
      } else {
        delete customizationState.selectedVariants[typeId];
      }

      updateVariantPrice();
    });
  });
}

async function updateVariantPrice() {
  if (!customizationState.product || Object.keys(customizationState.selectedVariants).length === 0) {
    // Si no hay variantes seleccionadas, usar precio base
    customizationState.variantPriceDelta = 0;
    updateCustomTotal();
    return;
  }

  try {
    const response = await fetch(`/api/productos/${customizationState.product.id}/calculate-variant-price`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selected_variants: customizationState.selectedVariants })
    });

    if (!response.ok) {
      console.error('Error calculating variant price');
      return;
    }

    const data = await response.json();
    customizationState.variantPriceDelta = data.totalPriceDelta || 0;
    updateCustomTotal();
  } catch (err) {
    console.error('Error updating variant price:', err);
  }
}

async function loadModelsForProduct(productId) {
  try {
    const res = await fetch(`/api/productos/${productId}/modelos`);
    const models = res.ok ? await res.json() : [];
    customizationState.models = models || [];

    if (customizationState.models.length) {
      const defaultModel = customizationState.models.find(m => m.is_default) || customizationState.models[0];
      customizationState.selectedModelId = Number(defaultModel.id);
      customizationState.selectedModelName = defaultModel.nombre;
      customizationState.selectedModelPriceDelta = defaultModel.price_delta || 0;
    } else {
      customizationState.selectedModelId = null;
      customizationState.selectedModelName = null;
      customizationState.selectedModelPriceDelta = 0;
    }

    renderModelOptions();
  } catch (e) {
    console.error('Error cargando modelos', e);
    customizationState.models = [];
    renderModelOptions();
  }
}

function renderModelOptions() {
  const container = document.getElementById('custom-models');
  if (!customizationState.models.length) {
    container.innerHTML = '<p style="opacity:0.8;">Sin variantes. Se usará el modelo base.</p>';
    return;
  }

  container.innerHTML = customizationState.models.map(m => `
    <label class="custom-model-option">
      <input type="radio" name="custom-model" value="${m.id}" ${Number(customizationState.selectedModelId) === Number(m.id) ? 'checked' : ''} onchange="onModelChange(${m.id})">
      <div>
        <strong>${escapeHtml(m.nombre)}</strong><br>
        <small>Stock: ${m.stock} · ${m.price_delta >= 0 ? '+' : ''}${parseFloat(m.price_delta || 0).toFixed(2)} €</small>
      </div>
    </label>
  `).join('');
}

function onModelChange(modelId) {
  const targetId = Number(modelId);
  const model = customizationState.models.find(m => Number(m.id) === targetId);
  if (!model) return;
  customizationState.selectedModelId = Number(model.id);
  customizationState.selectedModelName = model.nombre;
  customizationState.selectedModelPriceDelta = model.price_delta || 0;
  updateCustomTotal();
}

function handleFileSelection(input) {
  const files = Array.from(input.files || []);
  const limited = files.slice(0, 3);
  const valid = [];
  const errors = [];
  limited.forEach(f => {
    const isOkType = ['image/jpeg', 'image/png'].includes(f.type);
    const isOkSize = f.size <= 5 * 1024 * 1024;
    if (isOkType && isOkSize) {
      valid.push(f);
    } else {
      errors.push(`${f.name}: formato o tamaño inválido`);
    }
  });

  customizationState.files = valid;
  const list = document.getElementById('custom-file-list');
  list.innerHTML = valid.map(f => `<div class="custom-file-chip">${escapeHtml(f.name)} (${Math.round(f.size / 1024)} KB)</div>`).join('');
  if (errors.length) {
    alert(errors.join('\n'));
  }
}

function updateCustomTotal() {
  if (!customizationState.product) return;
  const base = parseFloat(customizationState.product.precio) || 0;
  const extras = parseFloat(customizationState.extras?.extrasTotal || 0);
  const variantDelta = parseFloat(customizationState.variantPriceDelta || 0);
  const modelDelta = parseFloat(customizationState.selectedModelPriceDelta || 0);
  const total = base + variantDelta + modelDelta + extras;
  const el = document.getElementById('custom-total');
  if (el) {
    el.textContent = total.toFixed(2);
  }
}

function closeCustomization() {
  customizationState = {
    product: null,
    models: [],
    selectedModelId: null,
    selectedModelName: null,
    selectedModelPriceDelta: 0,
    variantPriceDelta: 0,
    selectedVariants: {},
    files: [],
    extras: { upscale: false, qr: false, qrMessage: '', adapter: false, extrasTotal: 0, currency: 'CHF' }
  };
  const modal = document.getElementById('customization-modal');
  if (modal) {
    modal.classList.remove('show');
  }
}

function onExtraChange() {
  const upscale = document.getElementById('extra-upscale')?.checked || false;
  const qr = document.getElementById('extra-qr')?.checked || false;
  const adapter = document.getElementById('extra-adapter')?.checked || false;
  const qrMsgInput = document.getElementById('extra-qr-message');
  if (qrMsgInput) qrMsgInput.disabled = !qr;
  const qrMessage = qrMsgInput ? (qrMsgInput.value || '').trim() : '';

  const prices = { upscale: 5, qr: 5, adapter: 4 };
  const extrasTotal = (upscale ? prices.upscale : 0) + (qr ? prices.qr : 0) + (adapter ? prices.adapter : 0);

  customizationState.extras = { upscale, qr, qrMessage, adapter, extrasTotal, currency: 'CHF' };
  updateCustomTotal();
}

async function confirmCustomization() {
  if (!customizationState.product) return;
  const notes = document.getElementById('custom-notes').value.trim();

  try {
    let uploaded = [];
    if (customizationState.files.length) {
      const fd = new FormData();
      customizationState.files.forEach(f => fd.append('images', f));
      const res = await fetch('/api/uploads/custom', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        alert(data.error || 'Error al subir imágenes');
        return;
      }
      uploaded = data.files || [];
    }

    addToCart(
      customizationState.product.id,
      customizationState.product.nombre,
      customizationState.product.precio,
      {
        modelId: customizationState.selectedModelId,
        modelName: customizationState.selectedModelName,
        priceDelta: customizationState.selectedModelPriceDelta,
        images: uploaded,
        notes: buildNotesWithExtras(notes, customizationState.extras),
        extras: customizationState.extras
      }
    );

    closeCustomization();
  } catch (e) {
    console.error('Error al confirmar', e);
    alert('No se pudo agregar al carrito');
  }
}

// Load on page ready
document.addEventListener('DOMContentLoaded', () => {
  loadFeaturedProducts();
  const modal = document.getElementById('customization-modal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target.id === 'customization-modal') {
        closeCustomization();
      }
    });
  }
  // Initialize extras listeners if modal exists
  onExtraChange();
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

function buildNotesWithExtras(notes, extras) {
  const parts = [];
  if (notes && notes.trim()) parts.push(notes.trim());
  const extrasList = [];
  if (extras?.upscale) extrasList.push(`Upscale +5 ${extras.currency}`);
  if (extras?.qr) extrasList.push(`QR +5 ${extras.currency}${extras.qrMessage ? `: ${extras.qrMessage}` : ''}`);
  if (extras?.adapter) extrasList.push(`Adaptador USB +4 ${extras.currency}`);
  if (extrasList.length) parts.push(`Extras: ${extrasList.join(' · ')}`);
  return parts.join(' | ');
}




