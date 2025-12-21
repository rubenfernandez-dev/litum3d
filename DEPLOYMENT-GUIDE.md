# Guía de Despliegue en VPS - LITUM3D

Esta guía te ayudará a desplegar tu aplicación LITUM3D en un VPS (Ubuntu/Debian).

## 📋 Prerrequisitos en tu VPS

### 1. Conectar a tu VPS
```bash
ssh root@tu_ip_del_vps
# o
ssh usuario@tu_ip_del_vps
```

### 2. Actualizar el sistema
```bash
sudo apt update && sudo apt upgrade -y
```

### 3. Instalar Node.js (versión 18 LTS o superior)
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
node --version  # Verificar instalación
npm --version
```

### 4. Instalar MySQL
```bash
sudo apt install mysql-server -y
sudo mysql_secure_installation  # Seguir las instrucciones para asegurar MySQL
```

Configurar MySQL:
```bash
sudo mysql
```

Dentro de MySQL:
```sql
CREATE DATABASE litum3d CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'litum3d_user'@'localhost' IDENTIFIED BY 'TU_PASSWORD_SEGURA';
GRANT ALL PRIVILEGES ON litum3d.* TO 'litum3d_user'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

### 5. Instalar PM2 (gestor de procesos)
```bash
sudo npm install -g pm2
```

### 6. Instalar Nginx (proxy reverso)
```bash
sudo apt install nginx -y
```

## 📦 Desplegar la Aplicación

### 1. Subir el código al VPS

**Opción A: Usando Git (Recomendado)**
```bash
# En tu VPS, crear directorio para la app
sudo mkdir -p /var/www/litum3d
sudo chown -R $USER:$USER /var/www/litum3d
cd /var/www/litum3d

# Si tienes repositorio Git
git clone tu_repositorio_git .

# O inicializar para subir código
git init
```

**Opción B: Usando SCP/SFTP**
```bash
# Desde tu máquina local (Windows PowerShell)
# Comprimir el proyecto (excluir node_modules)
tar -czf litum3d.tar.gz --exclude=node_modules --exclude=.git .

# Subir al VPS
scp litum3d.tar.gz usuario@tu_ip:/var/www/litum3d/

# En el VPS, descomprimir
cd /var/www/litum3d
tar -xzf litum3d.tar.gz
rm litum3d.tar.gz
```

**Opción C: Usando rsync (más eficiente)**
```bash
# Desde tu máquina local
rsync -avz --exclude 'node_modules' --exclude '.git' ./ usuario@tu_ip:/var/www/litum3d/
```

### 2. Configurar variables de entorno

En el VPS:
```bash
cd /var/www/litum3d
nano .env
```

Contenido del archivo `.env`:
```env
# Database
DB_HOST=localhost
DB_PORT=3306
DB_USER=litum3d_user
DB_PASSWORD=TU_PASSWORD_SEGURA
DB_NAME=litum3d

# Server
PORT=3000
NODE_ENV=production

# Session
SESSION_SECRET=genera_un_string_aleatorio_muy_largo_y_seguro_aqui

# Email (Nodemailer - configurar según tu proveedor)
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=tu_email@gmail.com
EMAIL_PASS=tu_contraseña_de_aplicación

# Stripe (para pagos)
STRIPE_SECRET_KEY=tu_clave_secreta_de_stripe
STRIPE_PUBLISHABLE_KEY=tu_clave_publica_de_stripe

# URLs
BASE_URL=https://tudominio.com
```

**⚠️ Importante:** 
- Cambia `TU_PASSWORD_SEGURA` por la contraseña de MySQL
- Genera un SESSION_SECRET seguro: `openssl rand -base64 32`
- Configura tus credenciales de Stripe y email

### 3. Instalar dependencias
```bash
cd /var/www/litum3d
npm install --production
```

### 4. Inicializar la base de datos
```bash
# Ejecutar schema inicial
mysql -u litum3d_user -p litum3d < database/schema.sql

# Ejecutar migraciones si existen
mysql -u litum3d_user -p litum3d < database/migrations/add_historial_estado.sql

# O usar el script de inicialización
npm run db:init
```

### 5. Crear directorio de logs para PM2
```bash
mkdir -p /var/www/litum3d/logs
```

### 6. Iniciar la aplicación con PM2
```bash
cd /var/www/litum3d
pm2 start ecosystem.config.cjs

# Ver logs
pm2 logs litum3d

# Ver estado
pm2 status

# Configurar PM2 para iniciar automáticamente al reiniciar el servidor
pm2 startup
pm2 save
```

## 🌐 Configurar Nginx como Proxy Reverso

### 1. Crear configuración de Nginx
```bash
sudo nano /etc/nginx/sites-available/litum3d
```

Contenido:
```nginx
server {
    listen 80;
    server_name tudominio.com www.tudominio.com;  # Cambiar por tu dominio

    # Seguridad
    client_max_body_size 10M;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # Optimización para archivos estáticos
    location ~* \.(jpg|jpeg|png|gif|ico|css|js|svg|woff|woff2|ttf|eot)$ {
        proxy_pass http://localhost:3000;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
```

### 2. Activar el sitio
```bash
sudo ln -s /etc/nginx/sites-available/litum3d /etc/nginx/sites-enabled/
sudo nginx -t  # Verificar configuración
sudo systemctl restart nginx
```

## 🔒 Configurar SSL con Let's Encrypt (HTTPS)

### 1. Instalar Certbot
```bash
sudo apt install certbot python3-certbot-nginx -y
```

### 2. Obtener certificado SSL
```bash
sudo certbot --nginx -d tudominio.com -d www.tudominio.com
```

Sigue las instrucciones. Certbot configurará automáticamente Nginx para usar HTTPS.

### 3. Actualizar .env para HTTPS
```bash
nano /var/www/litum3d/.env
```

Asegúrate de que BASE_URL use https:
```env
BASE_URL=https://tudominio.com
```

Y reinicia PM2:
```bash
pm2 restart litum3d
```

### 4. Actualizar configuración de sesión en server.js
Si usas HTTPS, actualiza la configuración de cookies (esto debería hacerse en el código):
```javascript
cookie: { 
    secure: true, // Cambiar a true con HTTPS
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
}
```

## 🛡️ Seguridad Adicional

### 1. Configurar Firewall
```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

### 2. Permisos de archivos
```bash
cd /var/www/litum3d
sudo chown -R $USER:$USER .
chmod 755 public uploads
chmod 644 .env
```

### 3. Proteger archivos sensibles
```bash
# Asegurar que .env no sea accesible desde web
sudo nano /etc/nginx/sites-available/litum3d
```

Agregar dentro del bloque `server`:
```nginx
location ~ /\. {
    deny all;
}

location ~* \.(env|md|sql|config)$ {
    deny all;
}
```

Reiniciar Nginx:
```bash
sudo systemctl restart nginx
```

## 📊 Monitoreo y Mantenimiento

### Comandos útiles de PM2
```bash
pm2 status              # Ver estado de la app
pm2 logs litum3d        # Ver logs en tiempo real
pm2 restart litum3d     # Reiniciar app
pm2 stop litum3d        # Detener app
pm2 delete litum3d      # Eliminar de PM2
pm2 monit               # Monitor interactivo
```

### Comandos útiles de Nginx
```bash
sudo systemctl status nginx      # Estado
sudo systemctl restart nginx     # Reiniciar
sudo nginx -t                    # Verificar configuración
```

### Backup de la base de datos
```bash
# Crear backup
mysqldump -u litum3d_user -p litum3d > backup_$(date +%Y%m%d).sql

# Restaurar backup
mysql -u litum3d_user -p litum3d < backup_20231221.sql
```

### Ver logs del sistema
```bash
# Logs de Nginx
sudo tail -f /var/log/nginx/error.log
sudo tail -f /var/log/nginx/access.log

# Logs de la aplicación
pm2 logs litum3d --lines 100
```

## 🔄 Actualizar la Aplicación

Cuando necesites actualizar el código:

```bash
cd /var/www/litum3d

# Opción A: Con Git
git pull origin main
npm install --production

# Opción B: Subir archivos nuevos con rsync/scp

# Ejecutar migraciones si hay cambios en DB
mysql -u litum3d_user -p litum3d < database/migrations/nueva_migracion.sql

# Reiniciar la aplicación
pm2 restart litum3d
```

## ✅ Verificación Final

1. **Verificar que la app esté corriendo:**
   ```bash
   pm2 status
   curl http://localhost:3000/health
   ```

2. **Verificar Nginx:**
   ```bash
   sudo systemctl status nginx
   curl http://tudominio.com
   ```

3. **Verificar SSL (si configuraste HTTPS):**
   ```bash
   curl https://tudominio.com
   ```

4. **Acceder desde el navegador:**
   - `http://tudominio.com` o `https://tudominio.com`

## 🆘 Solución de Problemas

### La app no inicia
```bash
pm2 logs litum3d  # Ver errores
npm run db:check  # Verificar conexión a DB
```

### Error de conexión a MySQL
```bash
mysql -u litum3d_user -p litum3d  # Probar conexión manual
sudo systemctl status mysql       # Verificar que MySQL esté corriendo
```

### Error 502 Bad Gateway en Nginx
```bash
pm2 status        # Verificar que la app esté corriendo
pm2 logs litum3d  # Ver errores de la app
```

### Problemas con permisos de archivos
```bash
cd /var/www/litum3d
sudo chown -R $USER:$USER .
chmod -R 755 public uploads
```

## 📝 Notas Importantes

1. **Dominio:** Asegúrate de que tu dominio apunte a la IP de tu VPS (registro A en tu proveedor de dominio)
2. **Backups:** Configura backups automáticos de tu base de datos
3. **Actualizaciones:** Mantén Node.js, PM2, Nginx y MySQL actualizados
4. **Monitoreo:** Considera usar servicios como UptimeRobot para monitorear tu sitio

## 🎉 ¡Listo!

Tu aplicación LITUM3D debería estar funcionando en tu VPS. Si tienes algún problema, revisa los logs con `pm2 logs litum3d` y los logs de Nginx.
