# 📸 Guía para Agregar Imágenes a tus Productos

## ✅ Sistema Implementado

El sistema ahora está configurado para mostrar **imágenes reales** en lugar de emojis en la galería y página principal.

## 📁 Estructura de Carpetas

```
public/
  img/
    productos/        ← Nueva carpeta para imágenes de productos
```

## 🚀 Cómo Agregar Imágenes

### Paso 1: Preparar tus Imágenes

1. **Formato recomendado**: JPG, PNG o WebP
2. **Tamaño recomendado**: 800x800px o similar (cuadrado)
3. **Peso**: Menos de 500KB por imagen (optimiza para web)
4. **Nombres**: Sin espacios ni caracteres especiales
   - ✅ Correcto: `litofania-dragon.jpg`, `busto-medieval.png`
   - ❌ Incorrecto: `Mi Foto con espacios.JPG`

### Paso 2: Copiar Imágenes a la Carpeta

Copia tus imágenes a:
```
public/img/productos/
```

Ejemplo:
```
public/img/productos/
  ├── litofania-dragon.jpg
  ├── busto-medieval.png
  ├── figura-abstracta.jpg
  └── ...
```

### Paso 3: Actualizar la Base de Datos

Tienes **3 opciones**:

#### Opción A: Manualmente con SQL
```sql
UPDATE productos SET imagen = 'litofania-dragon.jpg' WHERE id = 1;
UPDATE productos SET imagen = 'busto-medieval.png' WHERE id = 2;
UPDATE productos SET imagen = 'figura-abstracta.jpg' WHERE id = 3;
```

#### Opción B: Con el script (recomendado)
1. Edita `scripts/actualizar-mis-fotos.js`
2. Cambia el array `productosConImagenes` con tus datos:
```javascript
const updates = [
  { id: 1, imagen: 'litofania-dragon.jpg' },
  { id: 2, imagen: 'busto-medieval.png' },
  { id: 3, imagen: 'figura-abstracta.jpg' },
];
```
3. Ejecuta: `node scripts/actualizar-mis-fotos.js`

#### Opción C: Al insertar nuevos productos
```sql
INSERT INTO productos (nombre, descripcion, precio, stock, imagen) 
VALUES ('Dragón Místico', 'Litofanía premium', 45.99, 10, 'litofania-dragon.jpg');
```

## 🎨 Cómo Funciona

- Si un producto **tiene imagen**: Muestra la imagen real
- Si un producto **NO tiene imagen**: Muestra emoji de fallback (🐉, 🗿, ⚔️, etc.)
- Si la imagen **no se encuentra**: Automáticamente vuelve al emoji

## 🔍 Verificar que Funciona

1. Asegúrate de que el servidor esté corriendo
2. Abre http://localhost:3000
3. Ve a la Galería o página principal
4. Deberías ver las imágenes reales en las tarjetas de productos

## 💡 Tips

- **Optimiza las imágenes** antes de subirlas (usa TinyPNG, Squoosh, etc.)
- **Usa nombres descriptivos** para facilitar el mantenimiento
- **Mantén respaldo** de tus imágenes originales
- Las imágenes con **fondo transparente** se ven mejor

## ❓ Solución de Problemas

### No veo las imágenes
- ✅ Verifica que el nombre en la BD coincida exactamente con el archivo
- ✅ Confirma que la imagen esté en `public/img/productos/`
- ✅ Revisa la consola del navegador (F12) para ver errores

### Las imágenes se ven mal
- Redimensiónalas a un tamaño cuadrado (ej: 800x800px)
- El CSS automáticamente las ajusta con `object-fit: cover`

## 🎯 Próximos Pasos (Opcional)

- Implementar **lazy loading** para mejorar rendimiento
- Agregar **múltiples imágenes** por producto (galería)
- Crear sistema de **upload de imágenes** desde admin panel
