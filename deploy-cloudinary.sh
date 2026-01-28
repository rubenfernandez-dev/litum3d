#!/bin/bash

# ============================================
# Script de Deployment - Cloudinary Setup
# ============================================
# Uso: bash deploy-cloudinary.sh
# Este script configura Cloudinary en producción

echo "🚀 Iniciando Deployment - Cloudinary Setup"
echo "=========================================="

# Colores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Paso 1: Verificar que estamos en el directorio correcto
if [ ! -f "server.js" ]; then
    echo -e "${RED}❌ Error: No estás en el directorio raíz de LITUM3D${NC}"
    echo "   Usa: cd /path/to/litum3d"
    exit 1
fi

echo -e "${GREEN}✅ Directorio correcto${NC}"

# Paso 2: Verificar variables de entorno
echo ""
echo "🔍 Verificando variables de entorno..."

if [ -z "$CLOUDINARY_CLOUD_NAME" ]; then
    echo -e "${YELLOW}⚠️ CLOUDINARY_CLOUD_NAME no configurada${NC}"
    read -p "Ingresa CLOUDINARY_CLOUD_NAME: " CLOUDINARY_CLOUD_NAME
fi

if [ -z "$CLOUDINARY_API_KEY" ]; then
    echo -e "${YELLOW}⚠️ CLOUDINARY_API_KEY no configurada${NC}"
    read -sp "Ingresa CLOUDINARY_API_KEY: " CLOUDINARY_API_KEY
    echo ""
fi

if [ -z "$CLOUDINARY_API_SECRET" ]; then
    echo -e "${YELLOW}⚠️ CLOUDINARY_API_SECRET no configurada${NC}"
    read -sp "Ingresa CLOUDINARY_API_SECRET: " CLOUDINARY_API_SECRET
    echo ""
fi

# Paso 3: Actualizar archivo .env
echo ""
echo "📝 Actualizando .env..."

# Crear backup
if [ -f ".env" ]; then
    cp .env .env.backup
    echo -e "${GREEN}✅ Backup de .env guardado (.env.backup)${NC}"
fi

# Actualizar o crear variables
if grep -q "CLOUDINARY_CLOUD_NAME" .env 2>/dev/null; then
    # Actualizar si ya existen
    sed -i "s/CLOUDINARY_CLOUD_NAME=.*/CLOUDINARY_CLOUD_NAME=$CLOUDINARY_CLOUD_NAME/" .env
    sed -i "s/CLOUDINARY_API_KEY=.*/CLOUDINARY_API_KEY=$CLOUDINARY_API_KEY/" .env
    sed -i "s/CLOUDINARY_API_SECRET=.*/CLOUDINARY_API_SECRET=$CLOUDINARY_API_SECRET/" .env
else
    # Añadir si no existen
    echo "" >> .env
    echo "# Cloudinary" >> .env
    echo "CLOUDINARY_CLOUD_NAME=$CLOUDINARY_CLOUD_NAME" >> .env
    echo "CLOUDINARY_API_KEY=$CLOUDINARY_API_KEY" >> .env
    echo "CLOUDINARY_API_SECRET=$CLOUDINARY_API_SECRET" >> .env
fi

echo -e "${GREEN}✅ .env actualizado${NC}"

# Paso 4: Ejecutar script de verificación
echo ""
echo "🔍 Verificando configuración de Cloudinary..."
node scripts/check-cloudinary.js

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Cloudinary no está correctamente configurado${NC}"
    exit 1
fi

# Paso 5: Reiniciar la aplicación
echo ""
echo "🔄 Reiniciando aplicación..."

if command -v pm2 &> /dev/null; then
    pm2 restart litum3d
    echo -e "${GREEN}✅ Aplicación reiniciada con PM2${NC}"
elif command -v systemctl &> /dev/null; then
    systemctl restart litum3d
    echo -e "${GREEN}✅ Aplicación reiniciada con systemctl${NC}"
else
    echo -e "${YELLOW}⚠️ No se encontró PM2 o systemctl${NC}"
    echo "   Reinicia manualmente tu aplicación"
fi

echo ""
echo "=========================================="
echo -e "${GREEN}✅ Deployment completado!${NC}"
echo "=========================================="
echo ""
echo "📝 Próximos pasos:"
echo "  1. Verifica http://litum3d.com en el navegador"
echo "  2. Ve a /testimonios y sube una reseña con imágenes"
echo "  3. Verifica que aparecen en http://litum3d.com/admin-dashboard"
echo ""
