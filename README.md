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

## Scripts
```bash
# Desarrollo con live reload
npm run dev

# Producción local
npm start
```

## Estructura
- `server.js`: servidor Express
- `config/db.js`: pool MySQL
- `routes/`: rutas HTTP (`/`, `/about`, `/contact`, `/api/contact`)
- `views/`: HTML sin motor de plantillas
- `public/`: assets estáticos (`css`, `js`, `img`)

## MySQL
Ejemplo de creación de base y usuario:
```sql
CREATE DATABASE litum3d CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'litum'@'%' IDENTIFIED BY 'strong_password';
GRANT ALL PRIVILEGES ON litum3d.* TO 'litum'@'%';
FLUSH PRIVILEGES;
```
Ajusta variables en `.env`.

## Contacto (Nodemailer)
Configura SMTP en `.env` (`SMTP_*`) y el destinatario `CONTACT_TO`.

## PM2 (VPS)
En el servidor (Ubuntu):
```bash
# Instalar Node y PM2
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm i -g pm2

# Clonar repo y preparar
git clone https://github.com/TU_USUARIO/litum3d.git
cd litum3d
npm ci
cp .env.example .env
nano .env # configura variables

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

## GitHub
```bash
git init
git add .
git commit -m "Init LITUM3D"
# Crear repo en GitHub y enlazar
# git remote add origin https://github.com/TU_USUARIO/litum3d.git
# git push -u origin main
```
