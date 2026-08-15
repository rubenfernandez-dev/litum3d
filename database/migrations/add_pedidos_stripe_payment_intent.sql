-- Migración: columna pedidos.stripe_payment_intent_id (preparación P0E-B4)
-- Fecha: 2026-08-15
--
-- Columna preparatoria únicamente. NO se modifica en esta migración:
-- creación de pedidos, createOrderFromCart, notas LIKE, /confirm-payment,
-- ni el envío de emails. Nada del código de la aplicación escribe ni lee
-- esta columna todavía.
--
-- Corrección P0E-B4-PREFLIGHT: la columna y el UNIQUE KEY se comprueban y
-- aplican por separado (mismo patrón INFORMATION_SCHEMA ya usado en
-- add_product_variants.sql), en vez de un único ALTER TABLE atómico con
-- ambas cláusulas. Motivo demostrado contra MySQL real: si algo deja la
-- tabla en un estado parcial (columna ya presente pero UNIQUE KEY ausente),
-- reejecutar un ALTER TABLE combinado falla entero por ER_DUP_FIELDNAME y
-- scripts/run-migrations.js lo trata como "ya existe, omitiendo" — dejando
-- la tabla SIN el UNIQUE de forma silenciosa. Con las dos comprobaciones
-- independientes de abajo, cada pieza se repara por su cuenta.

SET @dbname = DATABASE();
SET @tablename = 'pedidos';

SET @columnname = 'stripe_payment_intent_id';
SET @preparedStatement = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = @columnname) > 0,
  'SELECT 1',
  'ALTER TABLE pedidos ADD COLUMN stripe_payment_intent_id VARCHAR(255) NULL'
));
PREPARE alterStatement FROM @preparedStatement;
EXECUTE alterStatement;
DEALLOCATE PREPARE alterStatement;

SET @indexname = 'unique_pedidos_stripe_payment_intent_id';
SET @preparedStatement = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND INDEX_NAME = @indexname) > 0,
  'SELECT 1',
  'ALTER TABLE pedidos ADD UNIQUE KEY unique_pedidos_stripe_payment_intent_id (stripe_payment_intent_id)'
));
PREPARE alterStatement FROM @preparedStatement;
EXECUTE alterStatement;
DEALLOCATE PREPARE alterStatement;
