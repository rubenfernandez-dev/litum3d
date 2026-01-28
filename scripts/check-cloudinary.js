#!/usr/bin/env node

/**
 * Script para verificar la configuración de Cloudinary
 * Uso: node scripts/check-cloudinary.js
 */

require('dotenv').config();

console.log('🔍 Verificando configuración de Cloudinary...\n');

const required = {
  'CLOUDINARY_CLOUD_NAME': process.env.CLOUDINARY_CLOUD_NAME,
  'CLOUDINARY_API_KEY': process.env.CLOUDINARY_API_KEY,
  'CLOUDINARY_API_SECRET': process.env.CLOUDINARY_API_SECRET
};

let allConfigured = true;

for (const [key, value] of Object.entries(required)) {
  if (value) {
    console.log(`✅ ${key}: ${key === 'CLOUDINARY_API_KEY' || key === 'CLOUDINARY_API_SECRET' ? '***' : value}`);
  } else {
    console.log(`❌ ${key}: NO CONFIGURADA`);
    allConfigured = false;
  }
}

console.log('\n' + '='.repeat(60));

if (allConfigured) {
  console.log('✅ Cloudinary está configurado correctamente!');
  console.log('\n✨ Las imágenes en reseñas se subirán a Cloudinary.');
  process.exit(0);
} else {
  console.log('❌ Cloudinary NO está configurado correctamente!');
  console.log('\n📝 Para configurar Cloudinary:');
  console.log('   1. Ve a https://cloudinary.com/console');
  console.log('   2. Copia tu Cloud Name, API Key y API Secret');
  console.log('   3. Edita el archivo .env y añade:');
  console.log('      CLOUDINARY_CLOUD_NAME=tu_cloud_name');
  console.log('      CLOUDINARY_API_KEY=tu_api_key');
  console.log('      CLOUDINARY_API_SECRET=tu_api_secret');
  console.log('\n⚠️ Sin Cloudinary, las imágenes en reseñas se pueden guardar sin subirse a CDN.');
  process.exit(1);
}
