-- Migración: columna pedidos.stripe_payment_intent_id (preparación P0E-B4)
-- Fecha: 2026-08-15
--
-- Columna preparatoria únicamente. NO se modifica en esta migración:
-- creación de pedidos, createOrderFromCart, notas LIKE, /confirm-payment,
-- ni el envío de emails. Nada del código de la aplicación escribe ni lee
-- esta columna todavía.

ALTER TABLE pedidos
  ADD COLUMN stripe_payment_intent_id VARCHAR(255) NULL,
  ADD UNIQUE KEY unique_pedidos_stripe_payment_intent_id (stripe_payment_intent_id);
