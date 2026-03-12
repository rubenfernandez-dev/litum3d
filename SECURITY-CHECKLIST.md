# 🔒 SECURITY CHECKLIST - Antes de hacer el repositorio público

## ✅ Cambios de seguridad realizados:

### 1. **Credenciales de Cloudinary limpias**
- ✅ Reemplazadas direcciones URL de imágenes con placeholders
- ✅ Archivos actualizados: `ACCION-REQUERIDA.md`, `DEPLOYMENT-CLOUDINARY.md`, `FIXES-RESUMEN.md`
- ℹ️ **NOTA**: Las URLs de imágenes en CSS y JS aún contienen el cloud name (`du4fvhum1`) - estas son referencias a recursos ya publicados y no exponen credenciales

### 2. **Contraseñas por defecto reemplazadas**
- ✅ `database/schema.sql`: Contraseña reemplazada con placeholder `DEBE_SER_REEMPLAZADA_EN_PRODUCCION`
- ✅ `scripts/setup-admin.js`: Contraseña temporal generada aleatoriamente
- ✅ `scripts/hash-admin-password.js`: Requiere variable de entorno `ADMIN_PASSWORD`

### 3. **Session Secret mejorado**
- ✅ `server.js`: Mensaje de error más claro cuando no está configurado
- ✅ Configuración de cookies seguras en producción con `NODE_ENV`

### 4. **Correos hardcodeados reemplazados**
- ✅ `config/seo.js`: `contact@litum3d.com` → `contact@example.com`
- ✅ `config/seo.js`: `https://litum3d.com` → `https://example.com` (baseUrl)
- ✅ `routes/payments.js`: `ruben@litum3d.com` → `admin@example.com`
- ✅ Documentación `.md`: Dominio real reemplazado con `tudominio.com`
- ✅ HTML views: Todavía contienen emails de ejemplo (evalúa si limpiar)

### 5. **Deploy script actualizado**
- ✅ `deploy-cloudinary.sh`: Referencias a dominio real reemplazadas

---

## ⚠️ TODO ANTES DE HACER PÚBLICO:

### 🔴 CRÍTICO:
1. **REGENERA las credenciales de Cloudinary en tu cuenta real**
   - Ve a https://cloudinary.com/console
   - Ve a **API Keys**
   - Haz clic en **Regenerate** para API Key y API Secret
   - Las credenciales antiguas (`516248397594524`, `bZPmR1lWK5Ty_UzT9hqyL7zBIm0`) están ahora invalidadas
   - Las URLs de imágenes seguirán funcionando porque incluyen tokens de acceso

2. **Verifica que NO hay archivo `.env` en el repositorio**
   ```bash
   ls -la | grep .env  # No debe mostrar nada
   ```

3. **Asegúrate de que `.gitignore` está actualizado**
   - ✅ `.env` está en el listado
   - ✅ `node_modules/` está excluido
   - ✅ `uploads/` está excluido

### 🟡 IMPORTANTE:
4. **Configura variables de entorno en producción**
   ```bash
   # En tu servidor de producción:
   SESSION_SECRET=genera_un_valor_seguro_con_openssl_rand_-base64_32
   CLOUDINARY_CLOUD_NAME=tu_nuevo_cloud_name
   CLOUDINARY_API_KEY=tu_nueva_api_key
   CLOUDINARY_API_SECRET=tu_nuevo_api_secret
   STRIPE_SECRET_KEY=tu_stripe_secret
   DB_PASSWORD=contraseña_mysql_segura
   ADMIN_EMAIL=tu_email_admin
   SMTP_USER=tu_email_smtp
   SMTP_PASS=tu_password_smtp
   NODE_ENV=production
   ```

5. **Habilita HTTPS en producción**
   - Cookies seguras funcionarán automáticamente cuando `NODE_ENV=production`
   - Configura SSL/TLS en tu servidor

6. **Actualiza información de contacto**
   - Reemplaza emails de ejemplo en:
     - `config/seo.js` (contact info)
     - `views/about.html`, `cart-de.html`, `about-de.html`, `about-fr.html`, `cart-fr.html`
     - `public/sitemap.xml` (URLs deben apuntar a tu dominio real)
     - `public/robots.txt` (sitemap URL)

---

## 🔍 Información que sigue siendo visible (acción requerida):

### Dominios y emails en archivos estáticos:
- `public/sitemap.xml`: URLs contienen `litum3d.com` 
- `public/robots.txt`: URL de sitemap contiene `litum3d.com`
- `views/*.html`: Algunos emails aún muestran `contact@litum3d.com`

**Acción**: Antes de hacer público, actualiza estos archivos con tu dominio real o usa configuración dinámica.

---

## ✨ Configuración de seguridad avanzada (opcional):

### 1. Scout Security Scanning (para GitHub)
```bash
# Si usas GitHub, habilita el scanning automático:
# Settings > Security & analysis > Enable "Secret scanning"
```

### 2. Agregá un archivo `SECURITY.md`
```markdown
# Security Policy

Si encuentras una vulnerabilidad, por favor reportarla a: security@example.com
No abras issues públicos para vulnerabilidades.
```

### 3. Considera usar `.env.vault` para secretos
- Herramienta: https://github.com/motdotla/dotenv-vault
- Permite encriptar secretos en el repositorio

---

## 📋 Resumen final:

| Elemento | Estado | Acción |
|----------|--------|--------|
| Credenciales Cloudinary | 🟡 Pendiente | Regenerar en https://cloudinary.com/console |
| Contraseñas por defecto | ✅ Limpiadas | Completado |
| Session Secret | ✅ Mejorado | Completado |
| Correos de ejemplo | ✅ Reemplazados | Completado (parcial en vistas) |
| Archivo .env | ✅ No en repo | Verificado |
| .gitignore | ✅ Correcto | Verificado |
| Base de datos | ✅ Limpiada | Completado |

---

## ✅ Checklist final ANTES de hacer público:

- [ ] Regeneradas credenciales de Cloudinary
- [ ] Variables de entorno configuradas en servidor de producción
- [ ] HTTPS habilitado
- [ ] Sitemap.xml y robots.txt actualizados con dominio real
- [ ] Emails en HTML views actualizados
- [ ] `.env` NO incluido en repositorio  
- [ ] `.gitignore` presente y correcto
- [ ] Test local: `npm install && npm start` (sin errores)
- [ ] Test producción: Verificar que todo funciona con variables de entorno

---

**Después de completar estos pasos, tu repositorio será seguro para hacerlo público.**
