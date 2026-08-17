// Session store de producción (P0-SECURITY-01, hardening final, secciones 4-10).
//
// MySQL en vez de MemoryStore, reutilizando el pool de mysql2 YA existente
// (config/db.js) -- ni Redis ni una segunda conexión a BD. express-mysql-session
// acepta una conexión/pool ya creada como segundo argumento del constructor
// (ver node_modules/express-mysql-session/index.js) y sabe usar tanto pools
// callback-style como el pool mysql2/promise que ya usa el resto del proyecto
// (comprueba `result instanceof Promise` internamente).
//
// createDatabaseTable:false A PROPÓSITO (sección 6): la tabla `sessions` la
// crea database/migrations/add_sessions_table.sql de forma explícita, nunca
// la librería "mágicamente" al arrancar. server.js verifica que esa tabla ya
// existe (SELECT 1 FROM sessions) ANTES de instanciar este store -- ver
// buildSessionStore() ahí, que es lo que hace fail-fast si falta la migración.
const session = require('express-session');
const MySQLStoreFactory = require('express-mysql-session')(session);
const { pool } = require('./db');

// Mismo valor que cookie.maxAge en server.js -- una sesión no debe poder
// sobrevivir en el store más tiempo del que la cookie del navegador la
// consideraría válida.
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

function createProductionSessionStore() {
  return new MySQLStoreFactory({
    createDatabaseTable: false,
    // Purga automática de sesiones expiradas (sección 10): compatible con la
    // librería, corre cada 15 min sobre la propia tabla `sessions` --
    // retención acotada, nunca infinita.
    clearExpired: true,
    checkExpirationInterval: 15 * 60 * 1000,
    expiration: SESSION_MAX_AGE_MS,
    schema: { tableName: 'sessions' }
  }, pool);
}

module.exports = { createProductionSessionStore, SESSION_MAX_AGE_MS };
