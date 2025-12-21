/**
 * SCRIPT DE PRUEBA PARA VARIANTES
 * 
 * Uso: Copia este código en la consola del navegador (F12)
 * para crear variantes de prueba sin necesidad de cURL
 */

const API_BASE = 'http://localhost:3000';

/**
 * Crear tipo de variante
 */
async function crearTipoVariante(productId, nombre, descripcion = '', isRequired = true) {
  try {
    const response = await fetch(`${API_BASE}/api/productos/${productId}/variant-types`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nombre,
        descripcion,
        is_required: isRequired,
        display_order: 1
      })
    });
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    console.log(`✅ Tipo "${nombre}" creado con ID: ${data.id}`);
    return data;
  } catch (err) {
    console.error(`❌ Error creando tipo: ${err.message}`);
    return null;
  }
}

/**
 * Crear opción de variante
 */
async function crearOpcionVariante(typeId, nombre, priceDelta = 0, stock = 10) {
  try {
    const response = await fetch(`${API_BASE}/api/variant-types/${typeId}/options`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nombre,
        price_delta: priceDelta,
        stock,
        display_order: 1
      })
    });
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    console.log(`✅ Opción "${nombre}" creada con ID: ${data.id} (delta: $${priceDelta})`);
    return data;
  } catch (err) {
    console.error(`❌ Error creando opción: ${err.message}`);
    return null;
  }
}

/**
 * Obtener tipos de variantes de un producto
 */
async function obtenerTiposVariantes(productId) {
  try {
    const response = await fetch(`${API_BASE}/api/productos/${productId}/variant-types`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    console.log(`📊 Tipos encontrados:`, data);
    return data;
  } catch (err) {
    console.error(`❌ Error obteniendo tipos: ${err.message}`);
    return [];
  }
}

/**
 * Calcular precio con variantes
 */
async function calcularPrecioVariantes(productId, selectedVariants) {
  try {
    const response = await fetch(
      `${API_BASE}/api/produtos/${productId}/calculate-variant-price`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selected_variants: selectedVariants })
      }
    );
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    console.log(`💰 Cálculo de precio:`, data);
    return data;
  } catch (err) {
    console.error(`❌ Error calculando precio: ${err.message}`);
    return null;
  }
}

/**
 * SETUP AUTOMÁTICO - Crear ejemplo completo
 * 
 * IMPORTANT: Asegúrate que existe producto con ID=1
 */
async function setupVariantesEjemplo() {
  console.log('🚀 Iniciando setup de ejemplo...\n');
  
  const productId = 1;
  
  // 1. Crear tipos de variantes
  console.log('PASO 1: Crear tipos de variantes');
  const tipoBase = await crearTipoVariante(productId, 'Base', 'Tipo de base del producto', true);
  const tipoForma = await crearTipoVariante(productId, 'Forma', 'Forma del producto', true);
  
  if (!tipoBase || !tipoForma) {
    console.error('❌ No se pudieron crear los tipos. Abortando.');
    return;
  }
  
  const typeIdBase = tipoBase.id;
  const typeIdForma = tipoForma.id;
  
  // 2. Crear opciones para Base
  console.log('\nPASO 2: Crear opciones para Base');
  await crearOpcionVariante(typeIdBase, 'Madera', 5.00, 20);
  await crearOpcionVariante(typeIdBase, 'Plástico', 2.00, 30);
  await crearOpcionVariante(typeIdBase, 'Metal', 8.00, 15);
  
  // 3. Crear opciones para Forma
  console.log('\nPASO 3: Crear opciones para Forma');
  await crearOpcionVariante(typeIdForma, 'Cilíndrica', 0.00, 25);
  await crearOpcionVariante(typeIdForma, 'Cuadrada', 3.00, 20);
  await crearOpcionVariante(typeIdForma, 'Hexagonal', 4.50, 15);
  
  // 4. Obtener y mostrar tipos creados
  console.log('\nPASO 4: Verificar tipos creados');
  await obtenerTiposVariantes(productId);
  
  // 5. Prueba de cálculo de precio
  console.log('\nPASO 5: Prueba de cálculo de precio');
  console.log('Seleccionando: Base(Madera +$5) + Forma(Hexagonal +$4.50)');
  await calcularPrecioVariantes(productId, {
    [typeIdBase]: 1,    // Madera (primera opción)
    [typeIdForma]: 3    // Hexagonal (tercera opción)
  });
  
  console.log('\n✨ Setup completado!');
  console.log('Recarga la página y haz click en "Comprar" para ver las variantes.\n');
}

/**
 * INSTRUCCIONES DE USO:
 * 
 * 1. Abre http://localhost:3000 en tu navegador
 * 2. Abre la consola (F12 -> Console)
 * 3. Copia y pega este script completo
 * 4. Espera a que se configure automáticamente
 * 5. Recarga la página (F5)
 * 6. Haz click en "Comprar" en un producto
 * 7. Deberías ver los selectores de variantes
 * 
 * FUNCIONES DISPONIBLES EN CONSOLA:
 * - crearTipoVariante(productId, nombre, descripcion, isRequired)
 * - crearOpcionVariante(typeId, nombre, priceDelta, stock)
 * - obtenerTiposVariantes(productId)
 * - calcularPrecioVariantes(productId, selectedVariants)
 * - setupVariantesEjemplo()  ← Esta crea un ejemplo completo
 */

// Ejecutar setup automático
setupVariantesEjemplo();
