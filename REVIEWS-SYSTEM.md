# 🌟 Sistema de Reseñas - LITUM3D

## Introducción

Se ha implementado un sistema completo de reseñas (testimonios) con las siguientes características:

✅ **Reseñas de clientes** - Formulario para que los clientes dejen opiniones  
✅ **Galería de fotos** - Soporte de hasta 5 imágenes por reseña (almacenadas en Cloudinary)  
✅ **Moderación** - Panel admin para aprobar/rechazar/eliminar reseñas  
✅ **Destacadas** - Marcar reseñas para mostrar en página principal  
✅ **Multiidioma** - Disponible en ES, DE, FR  
✅ **Cloudinary** - Optimización y CDN automático de imágenes  

---

## 🗄️ Estructura de Base de Datos

Se crearon dos tablas:

### `reviews`
- `id` - ID de la reseña
- `nombre` - Nombre del cliente
- `email` - Email (opcional, no publicado)
- `comentario` - Texto de la reseña
- `rating` - Calificación 1-5
- `estado` - 'pendiente', 'aprobada', 'rechazada'
- `destacada` - Boolean para mostrar en index
- `fecha_creacion` - Timestamp
- `fecha_actualizacion` - Timestamp

### `review_images`
- `id` - ID de imagen
- `review_id` - FK a reviews
- `cloudinary_url` - URL pública de Cloudinary
- `cloudinary_public_id` - ID de Cloudinary para eliminar
- `orden` - Orden de presentación
- `fecha_subida` - Timestamp

---

## 🔌 Rutas API

### Públicas (sin autenticación)

#### `GET /api/reviews`
Obtiene todas las reseñas aprobadas
```
Query params:
- destacadas=true (opcional) - Solo reseñas marcadas como destacadas
```

Respuesta:
```json
[{
  "id": 1,
  "nombre": "María García",
  "comentario": "Excelente producto...",
  "rating": 5,
  "imagenes": ["url1", "url2"],
  "fecha_creacion": "2026-01-28..."
}]
```

#### `POST /api/reviews`
Cliente envía una reseña (queda pendiente de aprobación)
```
Content-Type: multipart/form-data

Campos:
- nombre (string, requerido)
- email (string, opcional)
- comentario (string, requerido)
- rating (1-5, requerido)
- fotos (files, máx 5, opcional)
```

### Admin (requieren autenticación)

#### `GET /api/admin/reviews`
Obtiene todas las reseñas (con estado)
```
Query params:
- estado=pendiente|aprobada|rechazada (opcional)
```

#### `POST /api/admin/reviews`
Admin crea una reseña
```
Mismos campos que /api/reviews
+ estado (pendiente|aprobada)
+ destacada (boolean)
```

#### `PATCH /api/admin/reviews/{id}`
Actualizar estado o marcar como destacada
```json
{
  "estado": "aprobada|rechazada",
  "destacada": true|false
}
```

#### `DELETE /api/admin/reviews/{id}`
Eliminar una reseña (y sus imágenes de Cloudinary)

---

## 🌐 Vistas y Rutas

### Frontend Público

| Ruta | Idioma | Descripción |
|------|--------|-------------|
| `/testimonios` | Español | Página de reseñas + formulario |
| `/testimonios-de` | Alemán | Página de reseñas + formulario |
| `/testimonios-fr` | Francés | Página de reseñas + formulario |

**Además:** Sección de reseñas destacadas en:
- `/` (index.html)
- `/index-de` (index-de.html)
- `/index-fr` (index-fr.html)

### Admin

Acceder a: `https://tudominio.com/admin`
- Click en botón "⭐ Reseñas"
- Panel completo de gestión

---

## 📂 Archivos Nuevos Creados

### Backend
```
routes/
  reviews.js                    # API de reseñas

config/
  cloudinary.js                 # Configuración Cloudinary

scripts/
  migrate-reviews.js            # Script para crear tablas

database/
  migrations/
    add_reviews_system.sql      # SQL de migración
```

### Frontend
```
views/
  testimonios.html              # Página ES
  testimonios-de.html           # Página DE
  testimonios-fr.html           # Página FR

public/js/
  testimonios.js                # Lógica página pública
  admin-reviews.js              # Lógica admin dashboard

public/css/
  styles.css                    # Estilos (ya incluidos)
```

---

## ⚙️ Configuración Requerida

### Variables de Entorno (.env)

Ya deberías tenerlas, pero verifica:

```env
# Cloudinary
CLOUDINARY_CLOUD_NAME=tu_cloud_name
CLOUDINARY_API_KEY=tu_api_key
CLOUDINARY_API_SECRET=tu_api_secret
```

Si no tienes estas credenciales, necesitas crearlas en [cloudinary.com](https://cloudinary.com)

### Instalación de Paquetes

```bash
npm install cloudinary
```

Ya está instalado, pero si no:
```bash
cd c:\Users\Ruben\Desktop\LITUM3D
npm install
```

---

## 🚀 Flujo de Uso

### Cliente enviando una reseña:

1. Visita `/testimonios` (o idioma correspondiente)
2. Completa formulario:
   - Nombre
   - Email (opcional)
   - Selecciona calificación (⭐⭐⭐⭐⭐)
   - Escribe comentario
   - Sube fotos (opcional, máx 5)
3. Click "Enviar Reseña"
4. Se sube a Cloudinary y queda **PENDIENTE** de aprobación
5. Recibes mensaje: "✅ Reseña enviada. Será publicada tras revisión"

### Tú (admin) moderando:

1. Accede a `/admin`
2. Click botón "⭐ Reseñas"
3. Filtras por estado (Pendientes, Aprobadas, Rechazadas)
4. Para cada reseña:
   - **Aprobar**: Aparecerá pública
   - **Rechazar**: Se marcará como rechazada
   - **Marcar destacada**: Aparecerá en homepage
   - **Eliminar**: Se borra (y fotos de Cloudinary)

### Cliente creando reseña desde admin:

1. Click "➕ Nueva Reseña"
2. Completa formulario (mismo que cliente)
3. Selecciona estado:
   - "Aprobada" = publícala inmediatamente
   - "Pendiente" = para revisar después
4. Check "⭐ Marcar como destacada" si quieres
5. Click "Crear Reseña"

---

## 📸 Cómo funcionan las imágenes

### Flujo de subida:

1. Usuario elige archivos locales (máx 5)
2. Se envían al servidor (multer descarta en `/uploads/temp/`)
3. Cloudinary SDK las sube a nube con:
   - **Carpeta:** `litum3d/reviews/`
   - **Optimización:** Redimensionamiento a 800px, calidad auto
   - **Seguridad:** Públicas pero con hash único
4. Cloudinary devuelve URLs
5. Se guardan URLs en BD (no archivos)
6. Archivos temporales se borran
7. Cliente ve imagen optimizada desde CDN Cloudinary

### Beneficios:
- ✅ VPS sin sobrecarga (fotos en nube)
- ✅ CDN global (carga rápida worldwide)
- ✅ Optimización automática (calidad/tamaño)
- ✅ Backup automático (en Cloudinary)
- ✅ Fácil eliminación (un click)

---

## 🎨 Personalización

### Cambiar estilos

Edita `public/css/styles.css`, sección "ESTILOS PARA SECCIÓN DE RESEÑAS"

### Cambiar textos

- **Página testimonios:** Edita `views/testimonios.html` (y -de, -fr)
- **JavaScript:** Edita `public/js/testimonios.js`
- **Admin:** Edita `public/js/admin-reviews.js`

### Cambiar límites

En `routes/reviews.js`:
```javascript
const upload = multer({ 
  dest: 'uploads/temp/',
  limits: { 
    fileSize: 5 * 1024 * 1024,  // Cambiar tamaño
    files: 5                     // Cambiar cantidad
  }
});
```

---

## 🐛 Troubleshooting

### Error: "Table 'reviews' doesn't exist"
```bash
# Ejecutar migración:
node scripts/migrate-reviews.js
```

### Cloudinary no funciona
- Verifica .env tiene credenciales correctas
- Reinicia servidor: `npm start`

### Fotos no suben
- Verifica credenciales Cloudinary
- Revisa límites de archivo (5MB máx)
- Revisa consola del navegador (F12)

### Reseñas no aparecen
- Verifica que estén en estado "aprobada"
- Revisa consola admin (F12)
- Intenta refrescar página

---

## 📊 Estadísticas y Monitoreo

### Ver estadísticas en admin:
- Número total de reseñas
- Pendientes de aprobación
- Rating promedio
- Fotos subidas

### Panel admin muestra:
- Lista de reseñas con cards bonitas
- Miniaturas de fotos
- Fecha y autor
- Botones de acción rápida

---

## 🔒 Seguridad

✅ **Validaciones:**
- Rating 1-5 (validado servidor y cliente)
- Email opcional (pero validado si se proporciona)
- Máx 5 fotos de 5MB cada una
- Solo imágenes permitidas

✅ **Autenticación:**
- Rutas admin requieren `req.session.admin`
- Solo admin puede moderar/crear reseñas
- Las reseñas públicas no ven email

✅ **Almacenamiento:**
- Fotos en Cloudinary (seguro, con backup)
- URLs públicas pero únicas por imagen
- Fácil eliminación de Cloudinary si se borra reseña

---

## 📞 Soporte

Si tienes problemas:

1. Revisa consola (F12 en navegador)
2. Revisa logs del servidor
3. Verifica archivo `.env` tiene credenciales
4. Ejecuta migración: `node scripts/migrate-reviews.js`
5. Reinicia servidor: `npm start`

---

## 🎉 ¡Listo!

Tu sistema de reseñas está:
- ✅ Completamente funcional
- ✅ Almacenando en BD MySQL
- ✅ Fotos en Cloudinary
- ✅ Moderación en admin panel
- ✅ Mostrado en homepage
- ✅ Disponible en 3 idiomas
- ✅ Optimizado para rendimiento

**¿Próximos pasos?**
1. Prueba subiendo una reseña desde `/testimonios`
2. Aprúebala en `/admin` → "⭐ Reseñas"
3. Marca como destacada
4. ¡Verás en homepage!

¡Que disfrutes! 🌟
