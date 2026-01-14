/**
 * PRODUCT VARIANTS - Modal con selección de variantes
 * Maneja la interfaz de selección de bases, formas, y otros tipos de variantes
 */

class ProductVariantsModal {
  constructor() {
    this.currentProductId = null;
    this.variantTypes = [];
    this.selectedVariants = {}; // { type_id: option_id }
    this.baseprice = 0;
    this.currentPrice = 0;
  }

  /**
   * Abre el modal de compra con carga de variantes
   */
  async openModal(productId, productName, basePrice) {
    this.currentProductId = productId;
    this.baseprice = basePrice;
    this.currentPrice = basePrice;
    this.selectedVariants = {};

    // Obtener tipos de variantes del producto
    await this.loadVariantTypes(productId);

    // Mostrar el modal
    this.showModal(productName, basePrice);
  }

  /**
   * Cargar tipos de variantes desde el servidor
   */
  async loadVariantTypes(productId) {
    try {
      const response = await fetch(`/api/productos/${productId}/variant-types`);
      if (!response.ok) {
        console.warn('No variant types found for this product');
        this.variantTypes = [];
        return;
      }
      this.variantTypes = await response.json();
    } catch (err) {
      console.error('Error loading variant types:', err);
      this.variantTypes = [];
    }
  }

  /**
   * Mostrar el modal de compra/variantes
   */
  showModal(productName, basePrice) {
    const modal = document.getElementById('customization-modal');
    if (!modal) {
      console.error('Modal element not found');
      return;
    }

    modal.classList.add('show');
    this.renderVariantsForm(productName, basePrice);
  }

  /**
   * Renderizar el formulario de selección de variantes
   */
  renderVariantsForm(productName, basePrice) {
    const variantsContainer = document.querySelector('.custom-section');
    if (!variantsContainer) return;

    // Si no hay variantes, mostrar formulario simple
    if (this.variantTypes.length === 0) {
      this.renderSimpleForm(productName, basePrice);
      return;
    }

    let html = '<h4>Selecciona las opciones de tu producto</h4>';

    // Crear selector para cada tipo de variante
    for (const variantType of this.variantTypes) {
      const required = variantType.is_required ? '(obligatorio)' : '(opcional)';
      html += `
        <div class="variant-type-group">
          <label>${variantType.nombre} ${required}</label>
          <select 
            class="variant-select" 
            data-type-id="${variantType.id}" 
            data-required="${variantType.is_required}"
            ${variantType.is_required ? 'required' : ''}>
            <option value="">-- Selecciona ${variantType.nombre.toLowerCase()} --</option>
      `;

      // Opciones para este tipo de variante
      for (const option of variantType.options) {
        const stockClass = option.stock > 0 ? '' : 'disabled';
        const stockText = option.stock > 0 ? `(${option.stock} disponibles)` : '(Agotado)';
        const priceDisplay = option.price_delta > 0 ? ` +$${option.price_delta.toFixed(2)}` : '';

        html += `
          <option 
            value="${option.id}" 
            data-price-delta="${option.price_delta}"
            data-stock="${option.stock}"
            ${option.stock <= 0 ? 'disabled' : ''}>
            ${option.nombre}${priceDisplay} ${stockText}
          </option>
        `;
      }

      html += `</select></div>`;
    }

    // Actualizar container con los selectores
    const variantsSection = document.querySelector('[data-variants-section]') || 
                           document.querySelector('.variant-types-container');
    
    if (variantsSection) {
      variantsSection.innerHTML = html;
      this.attachVariantListeners();
    }
  }

  /**
   * Adjuntar listeners a los selectores de variantes
   */
  attachVariantListeners() {
    document.querySelectorAll('.variant-select').forEach(select => {
      select.addEventListener('change', (e) => {
        const typeId = e.target.dataset.typeId;
        const optionId = e.target.value;

        if (optionId) {
          this.selectedVariants[typeId] = optionId;
        } else {
          delete this.selectedVariants[typeId];
        }

        this.updatePrice();
      });
    });
  }

  /**
   * Actualizar el precio basado en variantes seleccionadas
   */
  async updatePrice() {
    try {
      const response = await fetch(`/api/productos/${this.currentProductId}/calculate-variant-price`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selected_variants: this.selectedVariants })
      });

      if (!response.ok) {
        console.error('Error calculating price');
        return;
      }

      const data = await response.json();
      this.currentPrice = parseFloat(data.final_price);

      // Actualizar display de precio
      const priceDisplay = document.querySelector('[data-variant-price]');
      if (priceDisplay) {
        priceDisplay.textContent = `$${this.currentPrice.toFixed(2)}`;
      }

      // Actualizar validación
      this.validateSelection();
    } catch (err) {
      console.error('Error updating price:', err);
    }
  }

  /**
   * Validar que todas las variantes requeridas están seleccionadas
   */
  validateSelection() {
    const isValid = this.variantTypes
      .filter(vt => vt.is_required)
      .every(vt => this.selectedVariants[vt.id]);

    const addButton = document.querySelector('[data-add-to-cart-btn]');
    if (addButton) {
      addButton.disabled = !isValid;
    }

    return isValid;
  }

  /**
   * Renderizar formulario simple (sin variantes)
   */
  renderSimpleForm(productName, basePrice) {
    const priceDisplay = document.querySelector('[data-variant-price]');
    if (priceDisplay) {
      priceDisplay.textContent = `$${basePrice.toFixed(2)}`;
    }
  }

  /**
   * Obtener objeto de variantes seleccionadas en formato legible
   */
  getSelectedVariantsDisplay() {
    const display = [];

    for (const variantType of this.variantTypes) {
      if (this.selectedVariants[variantType.id]) {
        const optionId = this.selectedVariants[variantType.id];
        const option = variantType.options.find(o => o.id === parseInt(optionId));
        if (option) {
          display.push(`${variantType.nombre}: ${option.nombre}`);
        }
      }
    }

    return display;
  }

  /**
   * Agregar al carrito con variantes
   */
  addToCart(quantity = 1) {
    if (this.variantTypes.filter(vt => vt.is_required).length > 0) {
      if (!this.validateSelection()) {
        alert('Por favor selecciona todas las opciones requeridas');
        return false;
      }
    }

    // Crear objeto de carrito con variantes
    const cartItem = {
      product_id: this.currentProductId,
      quantity: quantity,
      price: this.currentPrice,
      variants: this.selectedVariants,
      variants_display: this.getSelectedVariantsDisplay().join(', ')
    };

    return cartItem;
  }
}

// Instancia global
const variantsModal = new ProductVariantsModal();

/**
 * Función pública para abrir modal desde botones HTML
 */
function openProductVariantsModal(productId, productName, basePrice) {
  variantsModal.openModal(productId, productName, basePrice);
}

/**
 * Función para cerrar el modal
 */
function closeVariantsModal() {
  const modal = document.getElementById('customization-modal');
  if (modal) {
    modal.classList.remove('show');
  }
}
