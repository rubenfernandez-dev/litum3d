# 🚀 INSTALACIÓN Y PRUEBA - SISTEMA COMPLETO

## ¿QUÉ HEMOS IMPLEMENTADO?

✅ **Navbar Hamburguesa** - Menú plegable en móviles
✅ **Sistema de Variantes** - Selección de bases, formas y más
✅ **Precio Dinámico** - Cálculo automático según opciones
✅ **Validación Inteligente** - Solo permite añadir cuando está todo ok
✅ **API Endpoints** - 7 nuevos endpoints para gestionar variantes

---

## 📋 PASOS DE INSTALACIÓN (15 MINUTOS)

### PASO 1️⃣: Ejecutar la migración SQL (1 minuto)

**Opción A - MySQL Workbench (Visual):**
1. Abre MySQL Workbench
2. Conectate a tu servidor
3. Archivo → Abrir script SQL
4. Selecciona: `database/migrations/add_product_variants.sql`
5. Click ejecutar (⚡ o Ctrl+Enter)
6. Verifica que dice "Query executed successfully"

**Opción B - Línea de comandos:**
```bash
cd c:\Users\Ruben\Desktop\LITUM3D
mysql -u root -p litum3d < database\migrations\add_product_variants.sql
# Ingresa tu contraseña cuando pida
```

**Opción C - Panel PhpMyAdmin:**
1. Abre http://localhost/phpmyadmin
2. Selecciona BD "litum3d"
3. Tab "SQL"
4. Copia contenido de `database/migrations/add_product_variants.sql`
5. Pega y ejecuta

---

### PASO 2️⃣: Iniciar el servidor Node (1 minuto)

```bash
# Abre PowerShell o CMD en la carpeta del proyecto
cd c:\Users\Ruben\Desktop\LITUM3D

# Inicia el servidor
npm start

# Deberías ver:
# > LITUM3D server running on http://localhost:3000
```

---

### PASO 3️⃣: Crear datos de prueba (3 minutos)

**Opción A - Con Console (MÁS FÁCIL):**

1. Abre http://localhost:3000 en el navegador
2. Abre las herramientas de desarrollador: **F12**
3. Ve a la pestaña **Console**
4. Copia TODO el contenido de `public/js/test-variantes.js`
5. Pégalo en la consola y presiona ENTER
6. Espera a ver "✨ Setup completado!"
7. Recarga la página (F5)

**Opción B - Con cURL (Terminal):**

```bash
# 1. Crear tipo "Base"
curl -X POST http://localhost:3000/api/productos/1/variant-types ^
  -H "Content-Type: application/json" ^
  -d "{\"nombre\": \"Base\", \"is_required\": true}"

# Recibirás: {"id": 1, "product_id": 1, "nombre": "Base", ...}
# Copia el ID (en este caso: 1)

# 2. Crear opción "Madera" para tipo 1
curl -X POST http://localhost:3000/api/variant-types/1/options ^
  -H "Content-Type: application/json" ^
  -d "{\"nombre\": \"Madera\", \"price_delta\": 5.00, \"stock\": 20}"

# 3. Crear opción "Plástico" para tipo 1
curl -X POST http://localhost:3000/api/variant-types/1/options ^
  -H "Content-Type: application/json" ^
  -d "{\"nombre\": \"Plástico\", \"price_delta\": 2.00, \"stock\": 30}"

# ... y así sucesivamente
```

**Opción C - SQL directo (Manual pero seguro):**

Abre `database/migrations/add_product_variants.sql`
Descomenta las últimas líneas (EJEMPLO DE DATOS)
Ejecuta el script

---

### PASO 4️⃣: Probar en el navegador (2 minutos)

1. Abre http://localhost:3000
2. Haz scroll hasta encontrar un producto
3. Haz click en el botón **"Comprar"** o **"Personalizar"**
4. Se abrirá un modal que ahora incluye:
   - **Select de Base** (si agregaste variantes)
   - **Select de Forma** (si agregaste variantes)
   - **Precio actualizado** dinámicamente
   - **Botón de compra** que se habilita cuando seleccionas todo

5. Prueba:
   - ✓ Selecciona "Madera" → Precio sube +$5
   - ✓ Selecciona "Cilíndrica" → Precio se suma +$0
   - ✓ Selecciona "Hexagonal" → Precio se suma +$4.50
   - ✓ Precio final: base + $5 + $4.50

---

## 📱 PROBAR NAVBAR HAMBURGUESA

1. Abre http://localhost:3000
2. Haz que la ventana sea más pequeña (menos de 768px de ancho)
   - Botón derecho → Inspeccionar (F12)
   - Click en "Toggle device toolbar" (icono móvil)
3. Selecciona un dispositivo móvil (iPhone 12 Pro)
4. Deberías ver un botón ☰ (hamburguesa) en la esquina derecha del navbar
5. Haz click → El menú se desliza desde la izquierda
6. Haz click en un link → El menú se cierra

---

## ✅ CHECKLIST DE VERIFICACIÓN

- [ ] Servidor Node corriendo en http://localhost:3000
- [ ] Migración SQL ejecutada sin errores
- [ ] Variantes creadas (Base y Forma)
- [ ] Modal muestra selectores de variantes
- [ ] Precio se actualiza al cambiar opciones
- [ ] Botón "Añadir al carrito" se habilita cuando todo está seleccionado
- [ ] Navbar muestra hamburguesa en móvil
- [ ] Menú hamburguesa abre/cierra correctamente

---

## 🎯 PRÓXIMAS ACCIONES

1. **Agregar más tipos de variantes**
   ```bash
   # Ejemplo: Color
   curl -X POST http://localhost:3000/api/productos/1/variant-types \
     -H "Content-Type: application/json" \
     -d '{"nombre": "Color", "is_required": false}'
   ```

2. **Personalizar estilos**
   - Edita `public/css/styles.css`
   - Busca `.variant-type-group` para cambiar apariencia

3. **Hacer obligatorio/opcional**
   - Base: obligatorio (is_required: true)
   - Color: opcional (is_required: false)

4. **Agregar más imágenes**
   - Usa campo `imagen` en `product_variant_options`
   - Para mostrar preview de cada opción

---

## 🐛 SOLUCIONAR PROBLEMAS

**"No veo las variantes en el modal"**
- Verifica en consola (F12): error "404 not found"?
- Comprueba que la tabla `product_variant_types` tiene datos
- Recarga la página (Ctrl+F5)

**"El precio no cambia"**
- Abre consola (F12) y busca errores
- Verifica que `price_delta` está correcto en la BD

**"El módulo no se carga"**
- Abre consola (F12)
- Busca "Failed to load module from..."
- Reinicia el servidor: Ctrl+C y `npm start`

**"Mobile no funciona"**
- Asegúrate que la ventana tiene menos de 768px
- Presiona Ctrl+Shift+M para toggle device toolbar

---

## 📚 ESTRUCTURA DE CARPETAS

```
LITUM3D/
├── database/
│   └── migrations/
│       └── add_product_variants.sql    ← ¡EJECUTA ESTO PRIMERO!
├── public/
│   ├── js/
│   │   ├── navbar.js                   ← Menú hamburguesa
│   │   ├── product-variants.js         ← Sistema de variantes
│   │   └── test-variantes.js           ← Script de prueba
│   └── css/
│       └── styles.css                  ← Estilos actualizados
├── routes/
│   └── variantes.js                    ← Endpoints de API
├── views/
│   ├── index.html                      ← Modal actualizado
│   └── ...                             ← Otros HTML con hamburguesa
├── server.js                           ← Servidor actualizado
├── VARIANTES-RESUMEN.md                ← Resumen rápido
└── VARIANTES-GUIA.md                   ← Documentación completa
```

---

## 🎓 CÓMO USAR LOS ENDPOINTS

### GET - Obtener variantes de un producto
```javascript
fetch('/api/productos/1/variant-types')
  .then(r => r.json())
  .then(data => console.log(data))
```

Respuesta:
```json
[
  {
    "id": 1,
    "product_id": 1,
    "nombre": "Base",
    "is_required": true,
    "options": [
      {"id": 1, "nombre": "Madera", "price_delta": 5.00},
      {"id": 2, "nombre": "Plástico", "price_delta": 2.00}
    ]
  },
  {
    "id": 2,
    "product_id": 1,
    "nombre": "Forma",
    "is_required": true,
    "options": [
      {"id": 3, "nombre": "Cilíndrica", "price_delta": 0.00},
      {"id": 4, "nombre": "Hexagonal", "price_delta": 4.50}
    ]
  }
]
```

### POST - Calcular precio
```javascript
fetch('/api/produtos/1/calculate-variant-price', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    selected_variants: {
      "1": "1",  // Tipo 1 (Base), Opción 1 (Madera)
      "2": "4"   // Tipo 2 (Forma), Opción 4 (Hexagonal)
    }
  })
})
  .then(r => r.json())
  .then(data => console.log(data))
```

Respuesta:
```json
{
  "base_price": 45.00,
  "total_delta": 9.50,
  "final_price": "54.50",
  "is_valid": true,
  "selected_variants": [
    {
      "type_id": "1",
      "type_name": "Base",
      "option_id": "1",
      "option_name": "Madera",
      "price_delta": 5.00
    },
    {
      "type_id": "2",
      "type_name": "Forma",
      "option_id": "4",
      "option_name": "Hexagonal",
      "price_delta": 4.50
    }
  ]
}
```

---

## 🎉 ¡LISTO!

Tu sistema está 100% funcional. 

**Próxima fase (opcional):**
- Conectar variantes seleccionadas al carrito
- Mostrar resumen de selecciones
- Guardar en pedidos
- Panel admin para gestionar variantes

¿Necesitas ayuda? Revisa VARIANTES-GUIA.md 📚
