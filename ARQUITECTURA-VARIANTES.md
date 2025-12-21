# 🏗️ ARQUITECTURA DEL SISTEMA DE VARIANTES

## 📐 DIAGRAMA DE FLUJO COMPLETO

```
┌──────────────────────────────────────────────────────────────────┐
│                    CLIENTE EN EL NAVEGADOR                       │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Abre http://localhost:3000                                  │
│     ↓                                                             │
│  2. Ve productos disponibles                                    │
│     ↓                                                             │
│  3. Click en "COMPRAR" en un producto                          │
│     ↓                                                             │
│  4. Se abre MODAL de compra                                    │
│     ├─→ Se carga JavaScript: product-variants.js               │
│     ├─→ Clase ProductVariantsModal activa                      │
│     └─→ Llama: GET /api/productos/1/variant-types              │
│           ↓                                                      │
│     5. SERVIDOR responde JSON con variantes                   │
│     ├─ { "id": 1, "nombre": "Base", "options": [...] }       │
│     ├─ { "id": 2, "nombre": "Forma", "options": [...] }      │
│     └─ Etc.                                                     │
│           ↓                                                      │
│     6. Frontend renderiza selectores                           │
│     ├─ <select> de Base                                        │
│     ├─ <select> de Forma                                       │
│     └─ Etc.                                                     │
│           ↓                                                      │
│     7. Cliente selecciona opciones                             │
│     ├─ Base: "Madera" (option_id: 1)                           │
│     └─ Forma: "Hexagonal" (option_id: 4)                       │
│           ↓                                                      │
│     8. Sistema calcula precio                                  │
│     ├─ POST /api/productos/1/calculate-variant-price           │
│     ├─ Con body: {"selected_variants": {"1": "1", "2": "4"}}  │
│     └─ Respuesta: {"final_price": "54.50"}                    │
│           ↓                                                      │
│     9. Precio se actualiza en modal                            │
│     ├─ "$54.50" se muestra al cliente                         │
│     └─ Botón "Añadir" se habilita                             │
│           ↓                                                      │
│    10. Cliente hace click "Añadir al carrito"                 │
│     ├─ Se guarda en localStorage:                              │
│     │  { product_id: 1, quantity: 1, price: 54.50,            │
│     │    variants: {"1": "1", "2": "4"} }                     │
│     └─ Se muestra notificación "Agregado al carrito"          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

           ↕ (HTTP REST)

┌──────────────────────────────────────────────────────────────────┐
│                         SERVIDOR NODE.JS                         │
│                                                                  │
│  Rutas en: routes/variantes.js                                 │
│  ├─ GET /api/productos/:id/variant-types                       │
│  │   └─ Query: SELECT FROM product_variant_types JOIN options  │
│  │                                                              │
│  ├─ POST /api/calculate-variant-price                          │
│  │   └─ Calcula: base_price + sum(deltas)                     │
│  │                                                              │
│  ├─ POST /api/variant-types/:id/options (crear)               │
│  ├─ PUT /api/variant-options/:id (actualizar)                  │
│  └─ DELETE /api/variant-options/:id (eliminar)                 │
│                                                                  │
│  Conexión: config/db.js (MySQL Pool)                           │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

           ↕ (SQL Queries)

┌──────────────────────────────────────────────────────────────────┐
│                      BASE DE DATOS MySQL                         │
│                                                                  │
│  product_variant_types                                          │
│  ├─ id: 1                                                       │
│  ├─ product_id: 1                                               │
│  ├─ nombre: "Base"                                              │
│  ├─ is_required: TRUE                                           │
│  └─ ...                                                         │
│                                                                  │
│  product_variant_options                                        │
│  ├─ id: 1, variant_type_id: 1, nombre: "Madera", delta: 5.00  │
│  ├─ id: 2, variant_type_id: 1, nombre: "Plástico", delta: 2.00│
│  ├─ id: 3, variant_type_id: 1, nombre: "Metal", delta: 8.00   │
│  ├─ id: 4, variant_type_id: 2, nombre: "Cilíndrica", delta: 0 │
│  ├─ id: 5, variant_type_id: 2, nombre: "Cuadrada", delta: 3.00│
│  ├─ id: 6, variant_type_id: 2, nombre: "Hexagonal", delta: 4.50│
│  └─ ...                                                         │
│                                                                  │
│  detalle_pedidos (ACTUALIZADO)                                 │
│  ├─ id, pedido_id, producto_id, ...                            │
│  ├─ variantes_seleccionadas: JSON {"1": "1", "2": "4"}        │
│  └─ combination_id: (opcional)                                 │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 📊 ESTRUCTURA DE DATOS

### Tabla: `product_variant_types`
```sql
┌─────────┬────────────┬─────────┬──────────────┬─────────────┐
│ id      │ product_id │ nombre  │ is_required  │ activo      │
├─────────┼────────────┼─────────┼──────────────┼─────────────┤
│ 1       │ 1          │ Base    │ TRUE         │ TRUE        │
│ 2       │ 1          │ Forma   │ TRUE         │ TRUE        │
│ 3       │ 2          │ Color   │ FALSE        │ TRUE        │
└─────────┴────────────┴─────────┴──────────────┴─────────────┘
```

### Tabla: `product_variant_options`
```sql
┌────┬──────────────────┬──────────────┬─────────────┬───────┐
│ id │ variant_type_id  │ nombre       │ price_delta │ stock │
├────┼──────────────────┼──────────────┼─────────────┼───────┤
│ 1  │ 1                │ Madera       │ 5.00        │ 20    │
│ 2  │ 1                │ Plástico     │ 2.00        │ 30    │
│ 3  │ 1                │ Metal        │ 8.00        │ 15    │
│ 4  │ 2                │ Cilíndrica   │ 0.00        │ 25    │
│ 5  │ 2                │ Cuadrada     │ 3.00        │ 20    │
│ 6  │ 2                │ Hexagonal    │ 4.50        │ 15    │
│ 7  │ 3                │ Rojo         │ 0.00        │ 100   │
│ 8  │ 3                │ Azul         │ 1.50        │ 80    │
└────┴──────────────────┴──────────────┴─────────────┴───────┘
```

---

## 🔄 CICLO DE VIDA DE UNA COMPRA CON VARIANTES

```
PASO 1: Carga de Variantes
├─ Cliente: GET /api/productos/1/variant-types
├─ Servidor: SELECT * FROM product_variant_types WHERE product_id=1
├─ Servidor: SELECT * FROM product_variant_options WHERE type_id IN (1,2)
└─ Cliente: Renderiza selectores dinámicamente

PASO 2: Cliente Selecciona Opciones
├─ Base: "Madera" (option_id: 1)
├─ Forma: "Hexagonal" (option_id: 6)
└─ Sistema: Almacena en memory {"1": "1", "2": "6"}

PASO 3: Cálculo de Precio
├─ Cliente: POST /calculate-variant-price
│   Body: {"selected_variants": {"1": "1", "2": "6"}}
├─ Servidor:
│   ├─ Obtiene precio base producto: $45.00
│   ├─ Obtiene deltas:
│   │   ├─ Madera (opt 1): +$5.00
│   │   └─ Hexagonal (opt 6): +$4.50
│   ├─ Calcula: $45 + $5 + $4.50 = $54.50
│   └─ Valida stock:
│       ├─ Madera: 20 > 0 ✓
│       └─ Hexagonal: 15 > 0 ✓
├─ Respuesta: {"final_price": "54.50", "is_valid": true}
└─ Cliente: Muestra "$54.50" y habilita botón

PASO 4: Cliente Agrega al Carrito
├─ Sistema: Crea objeto:
│   {
│     product_id: 1,
│     quantity: 1,
│     price: 54.50,
│     variants: {"1": "1", "2": "6"},
│     variants_display: "Base: Madera, Forma: Hexagonal"
│   }
├─ localStorage: Guarda carrito actualizado
└─ UI: Muestra notificación "¡Agregado!"

PASO 5: Checkout (Cuando vaya a pagar)
├─ Envía pedido con:
│   ├─ product_id: 1
│   ├─ quantity: 1
│   ├─ precio_unitario: 54.50
│   └─ variantes_seleccionadas: JSON {"1": "1", "2": "6"}
├─ Servidor: Inserta en detalle_pedidos
│   {
│     pedido_id: 100,
│     producto_id: 1,
│     cantidad: 1,
│     precio_unitario: 54.50,
│     variantes_seleccionadas: '{"1": "1", "2": "6"}'
│   }
└─ BD: Queda registrado para referencia

PASO 6: Post-Venta
├─ Admin puede ver variantes seleccionadas
├─ Conoce exactamente qué combinación vendió
└─ Puede filtrar pedidos por variantes
```

---

## 🎯 CASOS DE USO ESPECÍFICOS

### Caso 1: Producto simple SIN variantes
```
Producto 1: "Litofanía Básica"
→ No tiene tipos de variantes registrados
→ API devuelve []
→ Modal muestra solo opciones básicas (modelo, fotos, etc)
→ Precio: $45.00 (sin cambios)
```

### Caso 2: Producto CON variantes requeridas
```
Producto 2: "Litofanía Premium"
├─ Base (requerida)
│  ├─ Madera +$5
│  ├─ Plástico +$2
│  └─ Metal +$8
├─ Forma (requerida)
│  ├─ Cilíndrica +$0
│  ├─ Cuadrada +$3
│  └─ Hexagonal +$4.50
│
→ Cliente DEBE seleccionar ambas
→ Botón "Comprar" deshabilitado hasta que seleccione todo
→ Precio se calcula automáticamente
```

### Caso 3: Variantes opcionales
```
Producto 3: "Litofanía Estándar"
├─ Base (requerida)
├─ Forma (requerida)
└─ Color (OPCIONAL)
   ├─ Rojo +$0
   ├─ Azul +$1.50
   └─ Verde +$2.00

→ Color es "nice to have"
→ Cliente puede dejar sin seleccionar
→ Si lo selecciona, precio sube
```

---

## 🔐 VALIDACIONES EN ARQUITECTURA

```
FRONTEND (product-variants.js)
├─ ✓ Valida que todas las requeridas estén seleccionadas
├─ ✓ Habilita/deshabilita botón según validación
├─ ✓ Muestra estilos visuales de error
└─ ⚠️ NO es confiable (puede bypassearse)

BACKEND (routes/variantes.js) ← 🛡️ SEGURIDAD REAL
├─ ✓ Valida que option_id exista en BD
├─ ✓ Valida que type_id coincida con option_id
├─ ✓ Valida que variante exista para ese producto
├─ ✓ Valida que hay stock disponible
├─ ✓ Calcula precio correctamente
└─ ✓ Retorna error si algo falla

CONCLUSIÓN: El cliente puede engañar el frontend,
            pero el backend siempre valida correcto.
```

---

## 📈 ESCALABILIDAD

### Agregar nuevo tipo de variante (1 minuto)
```
POST /api/productos/1/variant-types
├─ Nombre: "Tamaño"
├─ is_required: true
└─ Respuesta: {id: 4, ...}

POST /api/variant-types/4/options
├─ Nombre: "Pequeño", delta: 0
└─ Nombre: "Grande", delta: 10
```

### Agregar 100 productos con variantes
```
La arquitectura soporta:
├─ Millones de registros en tablas
├─ Índices optimizados
├─ Queries eficientes (JOIN)
└─ Cacheo opcional en frontend
```

### Expandir a otros atributos
```
Hoy:
├─ Base (variante)
└─ Forma (variante)

Mañana:
├─ Base
├─ Forma
├─ Color
├─ Material de acabado
├─ Nivel de brillo
└─ ... limitless
```

---

## 🐛 DEBUGGING

### Si variantes no cargan
```
F12 → Console → Network
Buscar: /api/productos/1/variant-types

Si devuelve 404:
  └─ Tabla product_variant_types está vacía
  └─ Producto ID no existe

Si devuelve 200 pero []
  └─ No hay tipos creados para este producto
  └─ Ejecuta el script de prueba
```

### Si precio no se actualiza
```
F12 → Console → Network
Buscar: /calculate-variant-price

Si devuelve error:
  └─ Opción_id es inválido
  └─ Type_id no coincide
  └─ Producto no existe

Si devuelve 200 pero precio no sube:
  └─ price_delta está en 0
  └─ Revisa tabla product_variant_options
```

---

## 🎓 RESUMEN DE ARQUITECTURA

```
┌────────────────────────────────────────────────┐
│ PRESENTACIÓN (Frontend)                        │
│ ├─ HTML Modal con selectores                  │
│ ├─ CSS Estilos responsivos                    │
│ └─ JS ProductVariantsModal (controlador)      │
├────────────────────────────────────────────────┤
│ LÓGICA (Backend API)                          │
│ ├─ Rutas en routes/variantes.js               │
│ ├─ Validaciones completas                     │
│ ├─ Cálculos de precio                         │
│ └─ Control de stock                           │
├────────────────────────────────────────────────┤
│ DATOS (Base de datos)                         │
│ ├─ product_variant_types (tipos)              │
│ ├─ product_variant_options (opciones)         │
│ ├─ product_variant_combinations (combos)      │
│ └─ detalle_pedidos (historial)                │
└────────────────────────────────────────────────┘
```

¡Arquitectura sólida, escalable y profesional! 🚀
