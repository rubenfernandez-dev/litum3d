// ============================================
// Personalización de producto - lógica compartida entre /shop y Home
// (Destacados). Fuente única de verdad: extraída literalmente de
// public/js/shop.js (implementación canónica, ya reparada y probada) para
// que ambas páginas usen exactamente el mismo estado, el mismo cálculo de
// precio y el mismo objeto de carrito. No duplicar esta lógica en shop.js
// ni en home.js.
//
// Contrato con la página que carga este script:
//   - Debe cargarse ANTES de shop.js/home.js (declara `customizationState`,
//     `pricingConfig` y las funciones globales que ambos usan vía
//     onclick/onchange en el HTML del modal).
//   - La página es responsable de su propia lista de productos (catálogo
//     completo en /shop, destacados en Home) y debe llamar a
//     setCustomizationProducts(lista) cada vez que la actualice, para que
//     openCustomization(id) pueda encontrar el producto correcto.
//   - El HTML del modal debe exponer el mismo contrato DOM que
//     views/shop.html: #custom-modal-title, #custom-models,
//     #custom-notes, #custom-files, #custom-file-list, #extra-upscale,
//     #extra-qr, #extra-qr-message, #extra-adapter, #custom-base-price,
//     #custom-total, [data-variant-price], [data-variants-section]
//     .variant-types-container, #customization-modal.
// ============================================

// Única fuente de precios de extras: GET /api/pricing-config (servidor).
// null mientras no ha cargado o si la carga falló — nunca hay un fallback
// hardcodeado 5/5/4 en su lugar.
let pricingConfig = null;
let customizationState = {
  product: null,
  models: [],
  // Estado canónico de disponibilidad de modelos para el producto actual,
  // derivado exclusivamente de la respuesta de /variant-types (ver
  // loadModelsForProduct). NO se infiere de selectedModelId: eso solo dice
  // si el usuario eligió algo, no si había algo que elegir -- eran dos
  // preguntas distintas que antes se confundían en confirmCustomization().
  hasSelectableModels: false,
  // false mientras loadModelsForProduct() está en curso (o si falló): evita
  // que confirmCustomization() decida "no hace falta modelo" solo porque
  // hasSelectableModels todavía no se ha actualizado desde su valor inicial.
  modelsLoaded: false,
  selectedModelId: null,
  selectedModelName: null,
  selectedModelPriceDelta: 0,
  files: []
};

// Lista de productos en la que openCustomization(id) busca el producto a
// personalizar. Cada página la mantiene sincronizada con su propio origen
// de datos (catálogo completo en /shop, destacados en Home) llamando a
// setCustomizationProducts() cada vez que la actualiza.
let customizationProducts = [];

function setCustomizationProducts(products) {
  customizationProducts = products || [];
}

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

// AbortController de la apertura EN CURSO. openCustomization() es la única
// que lo crea/aborta: cada apertura cancela la anterior (haya terminado o
// no), y closeCustomization() también la cancela al cerrar sin abrir nada
// nuevo. loadModelsForProduct()/loadVariantTypes() reciben su signal y lo
// comprueban tras cada await -- así una respuesta que llega tarde para un
// producto ya cerrado o sustituido por otro NUNCA toca customizationState ni
// el DOM del producto que se esté mostrando ahora, y openCustomization()
// nunca reabre un modal que el usuario ya cerró (ver informe de la carrera).
let currentOpeningController = null;

/**
 * Abrir modal de personalización
 */
async function openCustomization(productId) {
  const product = customizationProducts.find(p => p.id === productId);
  if (!product) return;

  // Cualquier carga anterior (de este producto o de otro) deja de importar
  // en cuanto empieza una apertura nueva -- se aborta su fetch en curso y su
  // eventual respuesta tardía se descarta sin tocar nada (comprobación de
  // signal.aborted en loadModelsForProduct/loadVariantTypes).
  if (currentOpeningController) currentOpeningController.abort();
  const openingController = new AbortController();
  currentOpeningController = openingController;
  const { signal } = openingController;

  customizationState = {
    product,
    models: [],
    hasSelectableModels: false,
    modelsLoaded: false,
    selectedModelId: null,
    selectedModelName: null,
    selectedModelPriceDelta: 0,
    files: []
  };

  // Los checkboxes/mensaje de extras son estáticos (a diferencia de
  // #custom-models, que loadModelsForProduct() regenera por completo para
  // cada producto): sin este reset quedaban marcados/rellenos del producto
  // anterior, tanto en pantalla como en lo que confirmCustomization()
  // enviaría al carrito (getExtrasFromUI() los lee directamente del DOM).
  // Va ANTES de updateCustomizationPrice() para que el precio inicial ya
  // refleje el estado limpio.
  resetCustomizationExtrasUI();

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
  await loadModelsForProduct(product.id, signal);

  // Si esta apertura fue cancelada mientras esperábamos (el usuario cerró el
  // modal, o abrió otro producto antes de que esto terminara), no se debe
  // mostrar nada: hacerlo reabriría un modal que el usuario ya no espera ver,
  // con datos que ya no corresponden a la apertura actual.
  if (signal.aborted) return;

  // Mostrar modal
  document.getElementById('customization-modal').classList.add('show');
}

/**
 * Cargar modelos disponibles para un producto. Determina
 * customizationState.hasSelectableModels exclusivamente a partir de las
 * opciones que devuelve /variant-types para ESTE producto -- nunca por
 * id/nombre/posición -- de forma que un producto sin modelos configurados en
 * Admin deja de exigirlos, y uno al que Admin le añade modelos empieza a
 * exigirlos, sin tocar este código.
 *
 * `signal` identifica la apertura que la invocó (ver openCustomization): tras
 * cada await se comprueba signal.aborted antes de tocar customizationState o
 * el DOM, para que una respuesta perteneciente a una apertura ya superada
 * (cerrada, o sustituida por la de otro producto) se descarte en silencio en
 * vez de aplicarse al producto que se esté mostrando ahora.
 */
async function loadModelsForProduct(productId, signal) {
  // false durante toda la carga: confirmCustomization() debe permanecer
  // bloqueada mientras no se sepa con certeza si el producto tiene modelos
  // (ver comprobación al inicio de confirmCustomization).
  customizationState.modelsLoaded = false;
  const modelsContainer = document.getElementById('custom-models');
  const modelsSection = document.getElementById('custom-models-section');

  try {
    const res = await fetch(`/api/productos/${productId}/variant-types`, { signal });
    if (signal.aborted) return;
    if (!res.ok) throw new Error('Error al obtener variantes');

    const variantTypes = await res.json();
    if (signal.aborted) return;

    // Buscar el tipo de variante de modelo (usualmente por nombre, según lo
    // haya llamado Admin al crearlo: Base/Forma/Model/Shape...).
    const modelVariant = (variantTypes || []).find(v =>
      v.nombre.toLowerCase().includes('model') ||
      v.nombre.toLowerCase().includes('forma') ||
      v.nombre.toLowerCase().includes('shape')
    );
    const hasModels = !!(modelVariant && modelVariant.options && modelVariant.options.length > 0);

    customizationState.hasSelectableModels = hasModels;

    if (hasModels) {
      customizationState.models = modelVariant.options;
      if (modelsSection) modelsSection.style.display = '';
      modelsContainer.innerHTML = modelVariant.options.map(opt => `
        <label class="custom-model-option">
          <input type="radio" name="model" value="${opt.id}" onchange="selectModel(${opt.id}, '${escapeHtml(opt.nombre)}', ${opt.price_delta || 0})">
          <span>${escapeHtml(opt.nombre)} ${opt.price_delta ? `(+${parseFloat(opt.price_delta).toFixed(2)} €)` : ''}</span>
        </label>
      `).join('');
    } else {
      // Sin modelos configurados para este producto: no se renderiza una
      // selección vacía ni se exige nada (ver confirmCustomization).
      customizationState.models = [];
      if (modelsSection) modelsSection.style.display = 'none';
      modelsContainer.innerHTML = '';
    }

    // Cargar variantes adicionales (distintas del "modelo"). Se espera
    // (await) a que termine antes de marcar modelsLoaded=true: la apertura
    // debe conocer la configuración COMPLETA del producto (modelo + resto de
    // variantes), no solo la parte de "modelo", antes de considerarse lista.
    await loadVariantTypes(productId, signal);
    if (signal.aborted) return;

    customizationState.modelsLoaded = true;
  } catch (err) {
    // Un abort no es un fallo real: es la apertura anterior cediendo el
    // paso a una más reciente (u a un cierre). No se toca el DOM ni se
    // registra como error.
    if (signal.aborted) return;
    console.error(err);
    // modelsLoaded queda en false: no se sabe si el producto tiene modelos,
    // así que confirmCustomization() permanece bloqueada hasta reintentar
    // (mismo efecto práctico que el comportamiento previo ante error).
    if (modelsContainer) modelsContainer.innerHTML = '<p style="color: #ff6b6b;">Error al cargar opciones.</p>';
    if (modelsSection) modelsSection.style.display = '';
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
 * Cargar tipos de variantes. `signal`: ver loadModelsForProduct -- misma
 * apertura, mismo criterio de descarte si ya quedó superada.
 */
async function loadVariantTypes(productId, signal) {
  try {
    const res = await fetch(`/api/productos/${productId}/variant-types`, { signal });
    if (signal.aborted) return;
    if (!res.ok) return;

    const variantTypes = await res.json();
    if (signal.aborted) return;
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
    if (signal.aborted) return; // abort esperado (apertura superada), no un error real
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

  // Mientras no se sepa con certeza si el producto tiene modelos
  // configurados (carga en curso o fallida), no se puede decidir nada:
  // bloquear en vez de asumir "sin modelos" por defecto (ver loadModelsForProduct).
  if (!customizationState.modelsLoaded) {
    alert('Espera un momento: todavía se están cargando las opciones de personalización.');
    return;
  }

  // Un modelo es obligatorio SOLO si la configuración real del producto
  // (obtenida de /variant-types, ver loadModelsForProduct) tiene modelos
  // seleccionables. Si no los tiene, no se exige selección: distingue "no
  // hay nada que elegir" de "había algo y no se eligió", que es la causa
  // raíz del bug (antes solo se comprobaba selectedModelId, que no
  // distingue esos dos casos).
  if (customizationState.hasSelectableModels && !customizationState.selectedModelId) {
    alert('Por favor selecciona un modelo');
    return;
  }

  // Consentimiento de privacidad de fotos: solo existe hoy en el modal de
  // Home/ES (views/index.html#photo-consent); el de /shop no tiene este
  // control. Comprobación opcional -- si el elemento no existe en la
  // página actual, no se exige nada (mismo comportamiento que /shop de
  // siempre), y donde sí existe se preserva exactamente la misma validación
  // que tenía home.js antes de compartir esta lógica.
  const photoConsentCheckbox = document.getElementById('photo-consent');
  if (files.length > 0 && photoConsentCheckbox && !photoConsentCheckbox.checked) {
    alert('⚠️ Debes aceptar el tratamiento de tus fotos para continuar.\n\nLas fotos se utilizan para personalizar y gestionar tu pedido.');
    photoConsentCheckbox.focus();
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

    // variantOptionIds: el "modelo" (selectedModelId) es en realidad el ID
    // de una product_variant_options (el tipo cuyo nombre contiene
    // "model"/"forma"/"shape", ver loadModelsForProduct), NO un
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
        // modelId se deja explícitamente null: no existe una selección real
        // de product_models, solo de product_variant_options (ver
        // variantOptionIds más arriba). modelName se conserva solo como
        // etiqueta de presentación.
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
 * Reinicia los controles de extras del modal (Upscale/QR/mensaje/Adapter).
 * Única función de reset, reutilizada por closeCustomization() (deja el
 * modal limpio al cerrar) y openCustomization() (garantiza un estado
 * limpio para el producto que se abre, aunque el cierre anterior no haya
 * pasado por closeCustomization() -- p.ej. navegación con el botón atrás).
 * No hay customizationState.extras: getExtrasFromUI() los lee siempre del
 * DOM, así que resetear el DOM es resetear el único estado que existe.
 */
function resetCustomizationExtrasUI() {
  const upscale = document.getElementById('extra-upscale');
  const qr = document.getElementById('extra-qr');
  const qrMessage = document.getElementById('extra-qr-message');
  const adapter = document.getElementById('extra-adapter');
  if (upscale) upscale.checked = false;
  if (qr) qr.checked = false;
  if (qrMessage) {
    qrMessage.value = '';
    qrMessage.disabled = true; // igual que onExtraChange() cuando QR no está marcado
  }
  if (adapter) adapter.checked = false;
}

/**
 * Cerrar modal
 */
function closeCustomization() {
  // Cancela cualquier carga de modelos/variantes todavía en curso para el
  // producto que se está cerrando: sin esto, su respuesta podía llegar más
  // tarde y reabrir el modal o pisar el estado de la apertura siguiente (ver
  // openCustomization/loadModelsForProduct).
  if (currentOpeningController) {
    currentOpeningController.abort();
    currentOpeningController = null;
  }
  document.getElementById('customization-modal').classList.remove('show');
  document.getElementById('custom-notes').value = '';
  document.getElementById('custom-files').value = '';
  document.getElementById('custom-file-list').innerHTML = '';
  resetCustomizationExtrasUI();
  customizationState = {
    product: null,
    models: [],
    hasSelectableModels: false,
    modelsLoaded: false,
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
