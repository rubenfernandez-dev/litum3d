/*
  LITUM3D - P0-SECURITY-01 (hardening final, sección 2/21): chequeo PRE-DEPLOY
  de que todas las cuentas Admin tienen su contraseña en formato bcrypt.

  Runtime (routes/admin.js) ya NO acepta ningún fallback a texto plano
  (services/adminAuth.js): un registro no-bcrypt simplemente deja de poder
  autenticar. Este script existe para que ese "deja de poder autenticar" se
  descubra AQUÍ, conscientemente, antes de desplegar -- no en producción
  cuando un admin real intente entrar y no pueda.

  IMPORTANTE:
    - Se conecta a la BD configurada en el entorno donde se ejecute (usa
      config/db.js, igual que scripts/setup-admin.js/hash-admin-password.js).
      NO se ejecuta automáticamente como parte de `npm test` (ver
      package.json: es un script "predeploy:*" separado) -- así nunca toca
      accidentalmente una BD de producción sin que alguien lo pida a propósito.
    - NUNCA imprime el valor de `contraseña` (ni completo ni parcial), NUNCA
      el email completo (solo el id, que no es PII), y NUNCA corrige nada
      automáticamente -- ver sección 21 del ticket: "no corregirlo
      automáticamente".
    - NO reescribe ni resetea ninguna contraseña. Si encuentra un registro
      no-bcrypt, la resolución (reset manual/comunicación con el admin real)
      es una decisión humana fuera de este script.

  Salida:
    OK: todos los registros admin usan bcrypt              -> exit 0
    ERROR: N admin credential(s) requieren migración/reset -> exit 1

  Uso (consciente, antes de desplegar):
    node scripts/check-admin-password-hashes.js
    -- o --
    npm run predeploy:admin-password-check
*/
require('dotenv').config();
const { pool } = require('../config/db');
const { isBcryptHash } = require('../services/adminAuth');

async function main() {
  let rows;
  try {
    [rows] = await pool.query('SELECT id, contraseña FROM usuarios WHERE es_admin = 1');
  } catch (err) {
    console.error('[predeploy] No se pudo consultar la tabla usuarios:', err.code || err.message);
    process.exitCode = 1;
    return;
  } finally {
    // No se necesita el pool más allá de esta consulta; cerrarlo evita que
    // el proceso quede colgado esperando el pool de conexiones.
    await pool.end().catch(() => {});
  }

  if (rows.length === 0) {
    console.log('[predeploy] No hay ninguna cuenta con es_admin=1 -- nada que verificar.');
    console.log('OK: all admin password records use bcrypt');
    return;
  }

  const invalidIds = rows.filter((row) => !isBcryptHash(row.contraseña)).map((row) => row.id);

  if (invalidIds.length === 0) {
    console.log(`[predeploy] ${rows.length} cuenta(s) admin verificada(s).`);
    console.log('OK: all admin password records use bcrypt');
    return;
  }

  console.error(`[predeploy] ${invalidIds.length} de ${rows.length} cuenta(s) admin NO tienen un hash bcrypt válido (id: ${invalidIds.join(', ')}).`);
  console.error('[predeploy] No se ha modificado ni leído ningún valor de contraseña -- resolución manual requerida (reset seguro) antes de desplegar.');
  console.error('ERROR: Admin credential requires secure migration/reset before deployment');
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('[predeploy] Error inesperado:', err.message);
  process.exitCode = 1;
});
