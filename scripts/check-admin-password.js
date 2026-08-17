/*
  LITUM3D - P0-SECURITY-01 (hardening final, sección 1/3): verifica que
  services/adminAuth.js NUNCA acepta una comparación en texto plano, bajo
  ningún formato de valor almacenado.

  No usa BD: es un test puro sobre isBcryptHash()/verifyAdminPassword().

  Uso: node scripts/check-admin-password.js
*/
const assert = require('assert');
const bcrypt = require('bcryptjs');
const { isBcryptHash, verifyAdminPassword } = require('../services/adminAuth');

let checks = 0;
async function ok(cond, msg) { assert.ok(cond, msg); checks++; }
async function eq(a, b, msg) { assert.strictEqual(a, b, msg); checks++; }

async function main() {
  const PASSWORD = 'CorrectHorseBatteryStaple!1';
  const realHash = await bcrypt.hash(PASSWORD, 10);

  // A. bcrypt válido + password correcto -> login OK.
  {
    const result = await verifyAdminPassword(PASSWORD, realHash);
    await ok(result.valid === true, 'A: bcrypt válido + password correcto -> valid:true');
    await ok(result.requiresMigration === false, 'A: no requiere migración (el registro ya es un hash bcrypt real)');
  }

  // B. bcrypt válido + password incorrecto -> login falla.
  {
    const result = await verifyAdminPassword('password-incorrecta', realHash);
    await ok(result.valid === false, 'B: bcrypt válido + password incorrecto -> valid:false');
    await ok(result.requiresMigration === false, 'B: el registro sigue siendo un hash válido, solo la contraseña no coincide');
  }

  // C. CRÍTICO: registro con plaintext aparente + password igual -> login FALLA.
  // Nunca debe existir un camino donde storedValue === suppliedPassword autentique.
  {
    const result = await verifyAdminPassword(PASSWORD, PASSWORD);
    await ok(result.valid === false, 'C CRÍTICO: valor almacenado en texto plano == password recibida -> NUNCA autentica (sin fallback plaintext)');
    await ok(result.requiresMigration === true, 'C: se marca como "requiere migración" (el registro no es un hash bcrypt)');
  }

  // D. Formatos de hash inválidos/ajenos -> login falla, requiresMigration:true.
  const invalidStoredValues = [
    'plaintext-password-123',
    '',
    null,
    undefined,
    42,
    'md5:5f4dcc3b5aa765d61d8327deb882cf99', // MD5 de "password", con prefijo -- no es bcrypt
    require('crypto').createHash('sha256').update(PASSWORD).digest('hex'), // SHA-256 hex, longitud distinta
    '$2b$10$demasiadocorto', // prefijo bcrypt correcto pero cuerpo truncado/inválido
    '$2x$10$' + 'a'.repeat(53), // prefijo bcrypt con versión inexistente ($2x)
    realHash.slice(0, -1) // hash real pero truncado en 1 carácter -> deja de matchear el patrón exacto
  ];
  for (const stored of invalidStoredValues) {
    const result = await verifyAdminPassword(PASSWORD, stored);
    await ok(result.valid === false, `D: formato inválido ${JSON.stringify(stored)} -> valid:false`);
    await ok(result.requiresMigration === true, `D: formato inválido ${JSON.stringify(stored)} -> requiresMigration:true`);
  }

  // E. isBcryptHash(): positivo/negativo explícito, incluye los 3 prefijos válidos.
  await ok(isBcryptHash(await bcrypt.hash('x', 10)), 'E: un hash bcrypt recién generado por bcryptjs es reconocido como válido');
  await ok(isBcryptHash('$2a$10$' + 'A'.repeat(53)), 'E: prefijo $2a$ reconocido');
  await ok(isBcryptHash('$2b$12$' + 'B'.repeat(53)), 'E: prefijo $2b$ reconocido');
  await ok(isBcryptHash('$2y$08$' + 'C'.repeat(53)), 'E: prefijo $2y$ reconocido');
  await ok(!isBcryptHash('not-a-hash-at-all'), 'E: cadena arbitraria -> no es un hash bcrypt');
  await ok(!isBcryptHash(null), 'E: null -> no es un hash bcrypt');
  await ok(!isBcryptHash(123456), 'E: número -> no es un hash bcrypt');

  // F. Nunca lanza aunque bcrypt.compare reciba basura (defensa adicional).
  {
    const result = await verifyAdminPassword(null, realHash);
    await ok(typeof result.valid === 'boolean', 'F: suppliedPassword=null no lanza, devuelve un boolean');
  }

  console.log(`OK: ${checks} comprobaciones sobre verificación de contraseña Admin (sin fallback plaintext bajo ningún formato).`);
}

main().catch((err) => { console.error('FALLO:', err); process.exit(1); });
