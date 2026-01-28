# 📦 DEPLOYMENT INSTRUCTIONS - Cloudinary Setup

## El Problema
En producción, las imágenes de las reseñas no se guardan porque **Cloudinary no está configurado en el servidor**.

Error que ves:
```
Error: Must supply api_key
POST /api/admin/reviews 400 (Bad Request)
```

## La Solución (3 Pasos Simples)

### Paso 1: Obtener Credenciales de Cloudinary

1. **Ve a https://cloudinary.com/console**
2. **Copia tu Cloud Name** (visible en el dashboard principal)
   - Ejemplo: `du4fvhum1`
3. **Ve a API Keys** y copia:
   - **API Key**: Ejemplo `516248397594524`
   - **API Secret**: Ejemplo `bZPmR1lWK5Ty_UzT9hqyL7zBIm0`

### Paso 2: Configurar Variables de Entorno en Producción

**Opción A: Variables de Entorno del Sistema (Linux/Mac)**
```bash
export CLOUDINARY_CLOUD_NAME=du4fvhum1
export CLOUDINARY_API_KEY=516248397594524
export CLOUDINARY_API_SECRET=bZPmR1lWK5Ty_UzT9hqyL7zBIm0
```

**Opción B: Archivo .env en el Servidor**
```bash
# SSH al servidor y edita:
ssh user@litum3d.com
cd /path/to/litum3d

# Edita o crea .env:
nano .env

# Añade estas líneas:
CLOUDINARY_CLOUD_NAME=du4fvhum1
CLOUDINARY_API_KEY=516248397594524
CLOUDINARY_API_SECRET=bZPmR1lWK5Ty_UzT9hqyL7zBIm0
```

**Opción C: En Panel de Control (cPanel/Plesk)**
Si tu hosting tiene un panel:
1. Ve a Environment Variables
2. Añade las 3 variables
3. Reinicia la aplicación

### Paso 3: Reiniciar la Aplicación

```bash
# Si usas PM2:
pm2 restart litum3d

# Si usas Docker:
docker-compose restart

# Si usas systemd:
systemctl restart litum3d
```

## Verificar que Funciona

Después de configurar, puedes verificar localmente:
```bash
node scripts/check-cloudinary.js
```

Debería mostrar:
```
✅ CLOUDINARY_CLOUD_NAME: du4fvhum1
✅ CLOUDINARY_API_KEY: ***
✅ CLOUDINARY_API_SECRET: ***
✅ Cloudinary está configurado correctamente!
```

## Comportamiento Después

✅ **Con Cloudinary Configurado:**
- Las imágenes se suben a Cloudinary automáticamente
- Las reseñas aparecen con fotos en el dashboard
- Las reseñas aparecen con fotos en la página pública

⚠️ **Sin Cloudinary:**
- Las reseñas se guardan sin imágenes
- El sistema continúa funcionando
- Se muestra advertencia en logs

## Cambios de Código

Los siguientes cambios hacen el sistema más robusto:

1. **`config/cloudinary.js`**
   - Verifica si las credenciales están configuradas

2. **`routes/reviews.js`**
   - Maneja gracefully cuando Cloudinary no está disponible
   - Las reseñas se guardan sin imágenes si Cloudinary falla
   - No rompe el flujo de la aplicación

3. **`scripts/check-cloudinary.js`** (Nuevo)
   - Script para diagnosticar problemas
   - Verifica que las variables están configuradas

## Próximos Pasos

1. ✅ Configura las variables de entorno de Cloudinary en tu servidor
2. ✅ Reinicia la aplicación
3. ✅ Prueba cargando una reseña con imágenes
4. ✅ Verifica que aparecen en el admin dashboard

## Si Algo Sale Mal

### Error: "Must supply api_key"
- ❌ Las variables de entorno NO están configuradas
- ✅ Solución: Sigue el Paso 2 de arriba

### Las imágenes se guardan pero no aparecen
- ❌ Posible problema de CORS o permisos de Cloudinary
- ✅ Solución: Verifica que tu API Key es correcta en https://cloudinary.com/console

### El servidor no reinicia
- ❌ Error en la sintaxis del .env
- ✅ Solución: Asegúrate de que no hay espacios o caracteres especiales

## Soporte

Si tienes problemas:
1. Ejecuta `node scripts/check-cloudinary.js` localmente
2. Comprueba los logs del servidor: `pm2 logs litum3d`
3. Verifica que las credenciales son correctas en https://cloudinary.com/console
