-- Migración: Tabla de checkout drafts (snapshot server-side previo al cobro)
-- Fecha: 2026-08-15
--
-- Infraestructura de P0E-B3. Todavía SIN consumidores reales: ninguna ruta
-- HTTP, el checkout (public/js/checkout.js) ni Stripe leen o escriben esta
-- tabla en este momento. snapshot_json se persiste ya construido por el
-- llamante (futuro P0E-B4); esta migración no asume ni valida su esquema
-- interno.

CREATE TABLE IF NOT EXISTS checkout_drafts (
  id INT PRIMARY KEY AUTO_INCREMENT,
  idempotency_key VARCHAR(255) NOT NULL,
  selections_fingerprint CHAR(64) NOT NULL,
  access_token_hash CHAR(64) NOT NULL,
  stripe_payment_intent_id VARCHAR(255) NULL,
  snapshot_json JSON NOT NULL,
  status ENUM('created', 'payment_pending', 'converted', 'expired') NOT NULL DEFAULT 'created',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NULL,
  UNIQUE KEY unique_checkout_drafts_idempotency_key (idempotency_key),
  UNIQUE KEY unique_checkout_drafts_access_token_hash (access_token_hash),
  UNIQUE KEY unique_checkout_drafts_stripe_payment_intent_id (stripe_payment_intent_id),
  INDEX idx_checkout_drafts_status (status),
  INDEX idx_checkout_drafts_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
