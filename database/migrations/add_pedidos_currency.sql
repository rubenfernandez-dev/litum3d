-- Migración: columna pedidos.currency (EUR-ONLY-01)
-- Fecha: 2026-08-15
--
-- LITUM3D pasa a operar con una única moneda activa (EUR). pedidos no tenía
-- columna propia de moneda porque hasta ahora todo era CHF implícitamente;
-- tras el cambio eso sería ambiguo (pedidos antiguos -> probablemente CHF,
-- pedidos nuevos -> EUR). Esta migración SOLO añade la columna, nullable,
-- SIN DEFAULT: no relabela los pedidos históricos existentes. Una fila con
-- currency = NULL significa "pedido legacy sin moneda registrada
-- explícitamente", nunca se debe interpretar como EUR ni como CHF por
-- inferencia automática.
--
-- Patrón idempotente/autorreparable igual que
-- add_pedidos_stripe_payment_intent.sql: comprobación vía INFORMATION_SCHEMA
-- antes de ALTER TABLE, para que una reejecución (columna ya existente) no
-- falle. No necesita índice.

SET @dbname = DATABASE();
SET @tablename = 'pedidos';

SET @columnname = 'currency';
SET @preparedStatement = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = @columnname) > 0,
  'SELECT 1',
  'ALTER TABLE pedidos ADD COLUMN currency VARCHAR(3) NULL'
));
PREPARE alterStatement FROM @preparedStatement;
EXECUTE alterStatement;
DEALLOCATE PREPARE alterStatement;
