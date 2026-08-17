-- Migración: tabla de sesiones para express-session (P0-SECURITY-01,
-- hardening final).
--
-- Reemplaza MemoryStore (no apta para producción: pierde todas las sesiones
-- al reiniciar el proceso, no escala a multi-instancia) por un store MySQL
-- persistente, reutilizando la infraestructura de BD ya existente (mysql2,
-- config/db.js) -- sin añadir Redis ni ningún servicio nuevo.
--
-- Esquema IDÉNTICO al que usaría express-mysql-session@3.x si se le dejara
-- crear la tabla automáticamente (node_modules/express-mysql-session/schema.sql):
-- se crea aquí de forma EXPLÍCITA (config/sessionStore.js usa
-- createDatabaseTable:false) para no depender de que la librería modifique
-- el esquema "mágicamente" al arrancar la app.
--
-- Solo contiene lo estrictamente necesario para la sesión (id, expiración,
-- blob de datos de sesión ya serializado por express-session) -- ninguna
-- columna de PII adicional. El contenido de `data` ya lo controla el propio
-- proyecto (routes/admin.js: adminId/adminEmail/adminName/csrfToken).
--
-- Idempotente: CREATE TABLE IF NOT EXISTS, segura de ejecutar más de una vez
-- (ver scripts/check-session-store-mysql.js, que la aplica dos veces contra
-- un MySQL desechable de Docker).

CREATE TABLE IF NOT EXISTS sessions (
  session_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
  expires INT UNSIGNED NOT NULL,
  data MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
