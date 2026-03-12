# 🚨 ACCIÓN REQUERIDA - Configurar Cloudinary en Producción

## El Problema
Las imágenes de las reseñas NO se guardan en **https://tudominio.com**

## Causa
Las variables de entorno de Cloudinary NO están configuradas en el servidor

## Solución (5 minutos)

### 1️⃣ Obtener Credenciales
```
Ve a: https://cloudinary.com/console
Copia:
- Cloud Name: your_cloud_name
- API Key: your_api_key
- API Secret: your_api_secret
```

### 2️⃣ Configurar en Servidor
```bash
# SSH a tu servidor
ssh user@tudominio.com
cd /path/to/litum3d

# Editar .env
nano .env

# Añadir estas 3 líneas:
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
```

### 3️⃣ Actualizar Código
```bash
git pull origin main
```

### 4️⃣ Reiniciar
```bash
pm2 restart litum3d
# O tu comando equivalente
```

### 5️⃣ Verificar
```bash
node scripts/check-cloudinary.js
# Debería mostrar: ✅ Cloudinary está configurado correctamente!
```

## Listo ✅
Ahora las imágenes de reseñas se guardarán correctamente en producción.

---

**Documentación completa:** [DEPLOYMENT-CLOUDINARY.md](./DEPLOYMENT-CLOUDINARY.md)  
**Troubleshooting:** [CLOUDINARY-CONFIG.md](./CLOUDINARY-CONFIG.md)
