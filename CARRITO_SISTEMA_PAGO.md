# 🛒 Sistema de Carrito y Pago - Documentación Completa

## ✅ Implementación Completada

### 1. **Carrito de Compras Persistente (localStorage)**
- **Archivo**: `public/js/cart.js`
- **Funciones principales**:
  - `addToCart(productId, productName, productPrice)` - Añade producto al carrito
  - `removeFromCart(productId)` - Elimina producto del carrito
  - `updateCartQuantity(productId, quantity)` - Actualiza cantidad
  - `getCart()` - Obtiene carrito actual
  - `getCartTotal()` - Calcula total sin impuestos
  - `getCartCount()` - Número de artículos
  - `updateCartBadge()` - Actualiza el badge del carrito en navbar
  - `showCartNotification(message)` - Muestra notificación verde

### 2. **Página del Carrito (`/cart`)**
- **Archivo**: `views/cart.html`
- **Funcionalidad**:
  - Lista todos los artículos del carrito
  - Botones +/- para ajustar cantidades
  - Botón "Eliminar" para cada producto
  - Resumen de precios (subtotal, envío, IVA 21%)
  - Botón "Proceder al Pago" que redirige a `/checkout`
  - Botón "Continuar Comprando" que redirige a `/gallery`
  - Carrito vacío muestra mensaje amigable

### 3. **Página de Checkout con Stripe (`/checkout`)**
- **Archivo**: `views/checkout.html`
- **Funcionalidad**:
  - Formulario de datos de envío (nombre, email, teléfono, dirección, ciudad, zip)
  - Elemento de tarjeta de Stripe para datos de pago
  - Resumen de orden con todos los artículos
  - Cartel informativo: "Modo de prueba. Usa tarjeta 4242 4242 4242 4242"
  - Cálculo automático de total con IVA

### 4. **Script de Checkout (`public/js/checkout.js`)**
- **Funcionalidad**:
  - Inicializa cliente Stripe
  - Monta elemento de tarjeta Stripe
  - Renderiza resumen de orden
  - Maneja envío del formulario
  - Crea payment method y payment intent en Stripe
  - Llama a `/api/pay` para procesar pago y guardar orden
  - Limpia carrito tras éxito
  - Redirige a `/success?orderId=X` tras pago exitoso

### 5. **Endpoint de Pago (`/api/pay`)**
- **Archivo**: `routes/payments.js`
- **Funcionalidad**:
  - Recibe: `paymentMethodId`, `cart`, `customerData`
  - Calcula total con IVA
  - Crea Payment Intent con Stripe
  - Almacena orden en BD (tablas `pedidos` y `detalle_pedidos`)
  - **Envía 2 emails**:
    - **Cliente**: Confirmación de pedido con detalles
    - **Admin** (contact@litum3d.com): Notificación nueva orden
  - Retorna `orderId` para redirigir a página de éxito

### 6. **Página de Éxito (`/success`)**
- **Archivo**: `views/success.html`
- **Funcionalidad**:
  - Confirmación visual con ícono de éxito y animaciones
  - Muestra número de pedido
  - Detalle de pago y dirección de envío
  - Próximos pasos del proceso (2-4)
  - Botones para volver al inicio o continuar comprando
  - Notificación sobre emails enviados

### 7. **Integración en Páginas Existentes**
- **index.html (Inicio)**:
  - ✓ Botones "Comprar Ahora" en productos destacados llaman a `addToCart()`
  - ✓ Carrito badge en navbar mostrando cantidad de artículos
  - ✓ Script `cart.js` cargado

- **gallery.html (Galería)**:
  - ✓ Todos los botones "Comprar Ahora" usan `addToCart()` (no modal)
  - ✓ Carrito badge funcional
  - ✓ Scripts `cart.js` y `gallery.js` cargados

- **Navbar en todas las páginas**:
  - ✓ Icono 🛒 con badge de cantidad
  - ✓ Enlace a `/cart`

### 8. **Configuración de Stripe**
- **Modo de prueba activado**
- **Public Key**: `pk_test_51QsLCsJqC7yL3rEXLO5S9CqJIQaHwL4QNePdJLW5RrG7C9OqXB8jEPqLZxzqVQD2ItMJr3JQ5PqHdYlkPGQ200vd00R3bxXA3L`
- **Secret Key**: Guardada en `.env` (STRIPE_SECRET_KEY)
- **Tarjeta de prueba**: `4242 4242 4242 4242` (cualquier fecha futura, cualquier CVC)

### 9. **Envío de Emails**
- **Servicio**: Nodemailer
- **Configuración en `.env`**:
  - SMTP_HOST: smtp.gmail.com
  - SMTP_PORT: 587
  - SMTP_USER: ruben@litum3d.com (configurable)
  - SMTP_PASS: (necesita password)
  - ADMIN_EMAIL: contact@litum3d.com

- **Emails enviados automáticamente tras pago**:
  1. **Cliente**: HTML con orden, items, total, datos de envío
  2. **Admin**: HTML con datos cliente, items, nota "Preparar envío"

### 10. **Rutas Agregadas a `routes/index.js`**
```javascript
router.get('/cart', (req, res) => res.sendFile(path.join(viewsDir, 'cart.html')));
router.get('/checkout', (req, res) => res.sendFile(path.join(viewsDir, 'checkout.html')));
router.get('/success', (req, res) => res.sendFile(path.join(viewsDir, 'success.html')));
```

### 11. **Ruta de Pago en `server.js`**
```javascript
app.use('/api', paymentsRoutes); // Monta POST /api/pay
```

## 🧪 Instrucciones de Prueba

### 1. Agregar productos al carrito:
- Ir a inicio o galería
- Hacer clic en "Comprar Ahora" (cualquier producto)
- Ver notificación verde de confirmación
- Badge del carrito muestra cantidad

### 2. Ver carrito:
- Hacer clic en icono 🛒 o ir a `/cart`
- Ver lista de productos con cantidades
- Botones +/- para ajustar cantidades
- Botón X para eliminar items
- Resumen con subtotal, envío gratis, IVA 21%, total

### 3. Proceder al pago:
- En `/cart`, hacer clic "Proceder al Pago"
- Rellenar datos de envío:
  - Nombre: (cualquiera)
  - Email: tu_email@example.com
  - Teléfono: +34 666 666 666
  - Dirección: Calle Principal 123
  - Ciudad: Barcelona
  - Código Postal: 08001
- Rellenar datos de tarjeta (modo prueba):
  - Tarjeta: 4242 4242 4242 4242
  - Fecha: 12/26 (cualquier fecha futura)
  - CVC: 123 (cualquiera)

### 4. Completar pago:
- Hacer clic "Pagar €[total]"
- Esperar confirmación de Stripe
- Ver página de éxito con número de pedido
- Carrito se vacía automáticamente

### 5. Verificar emails:
- **Cliente**: Debe recibir en tu_email@example.com
  - Asunto: "Confirmación de Pedido #X - LITUM3D"
  - Contiene: lista de productos, precios, datos de envío
- **Admin**: contact@litum3d.com
  - Asunto: "Nuevo Pedido Pagado #X - [Nombre Cliente]"
  - Contiene: datos cliente, productos, nota de preparación

## 🔧 Configuración Necesaria

### Para que funcione el envío de emails:
En `.env`, configurar:
```
SMTP_USER=tu_email@gmail.com
SMTP_PASS=tu_app_password  # Usa App Password de Google (no la contraseña normal)
```

Para Gmail:
1. Activar 2FA en tu cuenta Google
2. Generar "App Password" en https://myaccount.google.com/apppasswords
3. Usar ese password en SMTP_PASS

### Base de datos:
Las tablas necesarias (`pedidos`, `detalle_pedidos`) ya existen en schema.sql y se crean automáticamente.

## 📊 Flujo de Datos

```
[Cliente agrega producto] 
    ↓ addToCart()
[localStorage 'litum3d_cart']
    ↓ (badge actualiza)
[/cart muestra items]
    ↓ goToCheckout()
[/checkout - Formulario + Stripe card]
    ↓ handleCheckout()
[Stripe.createPaymentMethod()]
    ↓ POST /api/pay
[Backend: crea Payment Intent]
    ↓ paymentIntent.confirm()
[Pago exitoso] → [Guarda en BD]
    ↓ [Envía 2 emails]
[/success?orderId=X]
    ↓ [Carrito vacío]
```

## ✨ Características Extras Implementadas

- **Notificaciones verdes**: Al agregar productos al carrito
- **Carrito badge dinámico**: Actualiza en toda la app
- **Validación de datos**: Todos los campos requeridos en checkout
- **Cálculo automático**: IVA 21% incluido en total
- **Animaciones**: Success icon con scaleIn animation
- **Responsive**: Compatible con móvil y desktop
- **Seguridad**: Payment Intent confirmado en backend, no en cliente
- **HTML Emails**: Emails formateados con estilos y tablas

## 📝 Notas Importantes

- El carrito persiste en localStorage hasta que el usuario lo limpia
- El pedido se crea en BD ANTES de enviar emails
- Si los emails fallan, el pedido ya está guardado
- Los números de Stripe test son válidos solo en modo prueba
- Stripe automáticamente maneja 3D Secure si es necesario
