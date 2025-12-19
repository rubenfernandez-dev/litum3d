# LITUM3D

Proyecto Node.js sencillo y eficiente con Express, MySQL y Nodemailer. Preparado para producción con PM2 y Nginx.

## Requisitos
- Node.js 18+
- MySQL 8+

## Instalación
```bash
npm install
cp .env.example .env
# Edita .env con tus credenciales
```

## BD - Crear estructura
Ejecuta el script SQL en tu servidor MySQL (local o VPS):
```bash
mysql -h HOST -u USER -p DB_NAME < database/schema.sql
```
Esto crea todas las tablas y algunos datos de prueba.

## Scripts
```bash
# Desarrollo con live reload
npm run dev

# Producción local
npm start

# PM2 (VPS)
npm run pm2
```

## API Endpoints

### Usuarios
- `GET /api/usuarios` - Listar usuarios
- `GET /api/usuarios/:id` - Obtener usuario
- `POST /api/usuarios` - Crear usuario
- `PUT /api/usuarios/:id` - Actualizar usuario
- `DELETE /api/usuarios/:id` - Desactivar usuario

### Productos
- `GET /api/productos` - Listar productos
- `GET /api/productos/:id` - Obtener producto
- `POST /api/productos` - Crear producto
- `PUT /api/productos/:id` - Actualizar producto
- `DELETE /api/productos/:id` - Desactivar producto

### Pedidos
- `GET /api/pedidos` - Listar pedidos
- `GET /api/pedidos/:id` - Obtener pedido con detalles
- `POST /api/pedidos` - Crear pedido (con detalles)
- `PUT /api/pedidos/:id/estado` - Cambiar estado del pedido

### Contacto
- `GET /api/contactos` - Listar contactos
- `GET /api/contactos/:id` - Obtener contacto
- `POST /api/contact` - Enviar contacto (desde formulario web)
- `PUT /api/contactos/:id/respondido` - Marcar como respondido

### Estados de Pedido
- `GET /api/estados` - Listar estados disponibles
- `POST /api/estados` - Crear nuevo estado

## Estructura
- `server.js`: servidor Express
- `config/db.js`: pool MySQL
- `database/schema.sql`: estructura BD (ejecutar en MySQL)
- `routes/`: rutas HTTP CRUD
- `views/`: HTML (sin motor de plantillas)
- `public/`: assets (`css`, `js`, `img`)

## MySQL (local para test)
```sql
CREATE DATABASE litum3d CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'litum'@'%' IDENTIFIED BY 'strong_password';
GRANT ALL PRIVILEGES ON litum3d.* TO 'litum'@'%';
FLUSH PRIVILEGES;
```
Luego ejecuta el script SQL.

## .env (ejemplo)
```
PORT=3000
DB_HOST=localhost
DB_PORT=3306
DB_USER=litum
DB_PASSWORD=strong_password
DB_NAME=litum3d

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=tu_email@gmail.com
SMTP_PASS=tu_contraseña_app
CONTACT_TO=contacto@tudominio.com
```

## PM2 (VPS)
En el servidor (Ubuntu):
```bash
# Instalar Node y PM2
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm i -g pm2

# Clonar repo y preparar
git clone https://github.com/rubenfernandez-dev/litum3d.git
cd litum3d
npm ci
cp .env.example .env
nano .env # configura variables

# Crear BD en tu VPS
mysql -h DB_HOST -u DB_USER -pDB_PASSWORD < database/schema.sql

# Iniciar con PM2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd
```

## Nginx (reverse proxy)
Archivo de sitio típico (`/etc/nginx/sites-available/litum3d`):
```nginx
server {
  listen 80;
  server_name TU_DOMINIO;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_cache_bypass $http_upgrade;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```
Activar y probar:
```bash
sudo ln -s /etc/nginx/sites-available/litum3d /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

# GitHub
```bash
git init
git add .
git commit -m "Init LITUM3D"
# Crear repo en GitHub (https://github.com/new) y enlazar
git remote add origin https://github.com/rubenfernandez-dev/litum3d.git
git branch -M main
git push -u origin main
```
