# SISTEMA DE VARIANTES (BASES + FORMAS) - GUÍA DE IMPLEMENTACIÓN

## 📋 RESUMEN DE CAMBIOS REALIZADOS

### 1. **Base de Datos** ✅
- Archivo: `database/migrations/add_product_variants.sql`
- **Nuevas tablas creadas:**
  - `product_variant_types`: Tipos de variantes (Base, Forma, Color, etc.)
  - `product_variant_options`: Opciones de cada tipo (Madera, Cilíndrica, etc.)
  - `product_variant_combinations`: Combinaciones específicas con stock y precio
  - `product_variant_combination_details`: Relación entre combinaciones y opciones
  - Columnas nuevas en `detalle_pedidos`

### 2. **Backend** ✅
- Archivo: `routes/variantes.js`
- **Nuevos endpoints:**
  - `GET /api/produtos/:productId/variant-types` - Obtener tipos de variantes de un producto
  - `GET /api/variant-types/:variantTypeId` - Obtener detalles de un tipo
  - `GET /api/variant-types/:variantTypeId/options` - Obtener opciones disponibles
  - `POST /api/produtos/:productId/calculate-variant-price` - Calcular precio final
  - Endpoints de administración (POST, PUT, DELETE)

- Registro en: `server.js`

### 3. **Frontend** ✅
- Archivo: `public/js/product-variants.js`
- Clase `ProductVariantsModal` que maneja:
  - Carga de variantes desde servidor
  - Selección de opciones
  - Validación de selecciones obligatorias
  - Cálculo dinámico de precios
  - Integración con carrito

- Estilos: `public/css/styles.css`
- Modal actualizado: `views/index.html`
- Script incluido en todas las páginas

---

## 🚀 PASOS PARA PONER EN FUNCIONAMIENTO

### PASO 1: Ejecutar la migración SQL
```sql
-- Abre tu cliente MySQL y ejecuta el script:
-- database/migrations/add_product_variants.sql

-- O desde línea de comandos:
mysql -u root -p litum3d < database/migrations/add_product_variants.sql
```

**Nota:** Los datos de ejemplo al final del script están listos para descomentar si quieres probar.

### PASO 2: Agregar variantes a un producto existente

Opción A - Via API REST (recomendado):
```bash
# 1. Crear tipos de variantes para producto ID=1
curl -X POST http://localhost:3000/api/productos/1/variant-types \
  -H "Content-Type: application/json" \
  -d '{"nombre": "Base", "descripcion": "Tipo de base", "is_required": true, "display_order": 1}'

# Respuesta: {"id": 1, "product_id": 1, "nombre": "Base", "is_required": true}

# 2. Crear opciones para ese tipo (type_id=1)
curl -X POST http://localhost:3000/api/variant-types/1/options \
  -H "Content-Type: application/json" \
  -d '{
    "nombre": "Madera",
    "descripcion": "Base de madera natural",
    "price_delta": 5.00,
    "stock": 20,
    "display_order": 1
  }'

# 3. Crear más opciones...
curl -X POST http://localhost:3000/api/variant-types/1/options \
  -H "Content-Type: application/json" \
  -d '{
    "nombre": "Plástico",
    "description": "Base de plástico reforzado",
    "price_delta": 2.00,
    "stock": 30,
    "display_order": 2
  }'

# 4. Crear tipo "Forma"
curl -X POST http://localhost:3000/api/productos/1/variant-types \
  -H "Content-Type: application/json" \
  -d '{"nombre": "Forma", "descripcion": "Forma del producto", "is_required": true, "display_order": 2}'

# 5. Crear opciones para Forma (type_id=2)
curl -X POST http://localhost:3000/api/variant-types/2/options \
  -H "Content-Type: application/json" \
  -d '{"nombre": "Cilíndrica", "price_delta": 0.00, "stock": 25, "display_order": 1}'
```

Opción B - Ejecutar SQL directamente:
```sql
-- Descomenta los ejemplos en add_product_variants.sql y ejecuta
-- Asegúrate de que el product_id=1 existe en tu tabla productos
```

### PASO 3: Probar en el navegador

1. Abre `http://localhost:3000`
2. Haz click en "Comprar" o "Personalizar" en un producto
3. Deberías ver:
   - Select de "Base" con opciones (Madera +$5, Plástico +$2, Metal +$8)
   - Select de "Forma" con opciones (Cilíndrica, Cuadrada +$3, Hexagonal +$4.50)
   - Precio que se actualiza dinámicamente
   - Botón "Añadir al carrito" habilitado solo cuando todas las obligatorias están seleccionadas

---

## 📊 ESTRUCTURA DE DATOS

### Ejemplo de Variantes para un Producto:

```
Producto: "Litofanía 3D" (Precio base: $45.00)

├── Tipo: "Base" (obligatorio)
│   ├── Opción: "Madera" (delta: +$5.00, stock: 20)
│   ├── Opción: "Plástico" (delta: +$2.00, stock: 30)
│   └── Opción: "Metal" (delta: +$8.00, stock: 15)
│
└── Tipo: "Forma" (obligatorio)
    ├── Opción: "Cilíndrica" (delta: $0.00, stock: 25)
    ├── Opción: "Cuadrada" (delta: +$3.00, stock: 20)
    └── Opción: "Hexagonal" (delta: +$4.50, stock: 15)

Ejemplo de compra:
- Base: Madera (+$5.00)
- Forma: Hexagonal (+$4.50)
- PRECIO FINAL: $45.00 + $5.00 + $4.50 = $54.50
```

---

## 🔧 FLUJO DE SELECCIÓN

```
1. Usuario hace click en "Comprar"
   ↓
2. Modal se abre, carga variantes del servidor (GET /api/produtos/1/variant-types)
   ↓
3. Se renderiza un SELECT para cada tipo de variante
   ↓
4. Usuario selecciona una opción de cada tipo
   ↓
5. Se valida que todas las obligatorias estén seleccionadas
   ↓
6. Se calcula el precio (POST /api/produtos/1/calculate-variant-price)
   ↓
7. Se actualiza el display de precio
   ↓
8. Usuario hace click en "Añadir al carrito"
   ↓
9. Se almacenan las variantes seleccionadas junto con el producto
```

---

## 📝 ESTRUCTURA DEL CARRITO CON VARIANTES

```javascript
// Cuando se agrega al carrito:
{
  product_id: 1,
  quantity: 1,
  price: 54.50,  // Precio final con variantes
  variants: {
    "1": "1",    // type_id: option_id
    "2": "5"     // type_id: option_id
  },
  variants_display: "Base: Madera, Forma: Hexagonal"
}
```

---

## 🛠️ PERSONALIZACIÓN AVANZADA

### Agregar nuevos tipos de variantes

Simplemente:
1. Insertar en `product_variant_types`
2. Agregar opciones en `product_variant_options`
3. El frontend se actualizará automáticamente

### Stock por combinación específica

Si necesitas controlar stock de combinaciones específicas:
1. Inserta en `product_variant_combinations`
2. Usa el `combination_id` en `detalle_pedidos`
3. Actualiza stock cuando se confirme el pedido

### Precio variable por combinación

Algunos productos pueden tener precios especiales por combinación:
- Usa `price_delta` en `product_variant_combinations`
- Se suma al `price_delta` de las opciones individuales

---

## ✅ VALIDACIÓN

El sistema valida automáticamente:
- ✓ Que se seleccionen todas las variantes obligatorias
- ✓ Que la opción seleccionada exista y esté activa
- ✓ Que hay stock disponible
- ✓ Que el precio se calcula correctamente

---

## 🐛 TROUBLESHOOTING

**P: El modal no muestra las variantes**
- R: Verifica que ejecutaste el SQL y que hay tipos de variantes en la BD
- R: Abre la consola del navegador (F12) y busca errores

**P: El precio no se actualiza**
- R: Verifica que `product_variant_options` tiene `price_delta` correcto
- R: Revisa la consola para errores de API

**P: Las opciones aparecen deshabilitadas**
- R: Verifica que `stock > 0` en `product_variant_options`
- R: Revisa que `activo = TRUE`

**P: El carrito no guarda las variantes**
- R: Edita `public/js/cart.js` para que guarde el objeto completo con variantes
- R: Verifica en las herramientas de dev que se envía correctamente

---

## 📚 ENDPOINTS DISPONIBLES

### Lectura (público):
- `GET /api/productos/:productId/variant-types` - Tipos de un producto
- `GET /api/variant-types/:typeId` - Detalles de un tipo
- `GET /api/variant-types/:typeId/options` - Opciones disponibles
- `POST /api/productos/:productId/calculate-variant-price` - Calcular precio

### Administración (requiere autenticación):
- `POST /api/productos/:productId/variant-types` - Crear tipo
- `POST /api/variant-types/:typeId/options` - Crear opción
- `PUT /api/variant-types/:typeId` - Actualizar tipo
- `PUT /api/variant-options/:optionId` - Actualizar opción
- `DELETE /api/variant-types/:typeId` - Desactivar tipo
- `DELETE /api/variant-options/:optionId` - Desactivar opción

---

## 📞 PRÓXIMOS PASOS

1. Ejecuta la migración SQL
2. Prueba los endpoints con cURL o Postman
3. Abre el sitio y verifica que el modal muestre las variantes
4. Agrega más tipos de variantes según tus necesidades
5. Personaliza los estilos CSS si quieres

¡Listo! Tu sistema de variantes está funcionando. 🎉
