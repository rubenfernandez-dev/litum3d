/**
 * Script para actualizar el stock de variantes existentes que tienen 0 o NULL
 */

const { pool } = require('../config/db');

async function fixVariantStock() {
  try {
    console.log('🔧 Actualizando stock de variantes...');
    
    // Actualizar todas las variantes con stock 0 o NULL a 100
    const [result] = await pool.query(
      `UPDATE product_variant_options 
       SET stock = 100 
       WHERE stock IS NULL OR stock = 0`
    );
    
    console.log(`✅ ${result.affectedRows} variantes actualizadas con stock = 100`);
    
    // Mostrar todas las variantes actualizadas
    const [variants] = await pool.query(
      `SELECT pvo.id, pvo.nombre, pvo.stock, pvt.nombre as tipo, pvt.product_id
       FROM product_variant_options pvo
       JOIN product_variant_types pvt ON pvo.variant_type_id = pvt.id
       ORDER BY pvt.product_id, pvt.nombre, pvo.nombre`
    );
    
    console.log('\n📦 Estado actual de variantes:');
    variants.forEach(v => {
      console.log(`  Producto ${v.product_id} - ${v.tipo}: ${v.nombre} → Stock: ${v.stock}`);
    });
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

fixVariantStock();
