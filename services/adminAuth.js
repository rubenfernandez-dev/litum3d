// Verificación de contraseña Admin (P0-SECURITY-01, hardening final).
//
// El runtime SOLO acepta el hash bcrypt real como formato válido -- nunca
// compara el valor almacenado con la contraseña recibida como si fuera texto
// plano. Un registro que no tiene forma de hash bcrypt es tratado como
// "requiere migración/reset seguro" (ver scripts/check-admin-password-hashes.js),
// NUNCA como una contraseña en claro utilizable para autenticar.
const bcrypt = require('bcryptjs');

// $2a$/$2b$/$2y$ + coste de 2 dígitos + 53 caracteres de salt+hash en base64
// bcrypt: forma exacta que produce bcryptjs (y cualquier bcrypt estándar).
const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

function isBcryptHash(value) {
  return typeof value === 'string' && BCRYPT_HASH_PATTERN.test(value);
}

// Nunca lanza, nunca compara storedValue con suppliedPassword como texto
// plano. requiresMigration:true significa "el registro no es un hash bcrypt
// válido" -- login debe fallar igual que una contraseña incorrecta, sin dar
// pistas de cuál fue el motivo (sección 9 del ticket original).
async function verifyAdminPassword(suppliedPassword, storedValue) {
  if (!isBcryptHash(storedValue)) {
    return { valid: false, requiresMigration: true };
  }
  try {
    const valid = await bcrypt.compare(suppliedPassword, storedValue);
    return { valid, requiresMigration: false };
  } catch (e) {
    return { valid: false, requiresMigration: false };
  }
}

module.exports = { isBcryptHash, verifyAdminPassword, BCRYPT_HASH_PATTERN };
