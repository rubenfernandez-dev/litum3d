/*
  LITUM3D - Test de la protección "fail closed" del integration test MySQL
  (P0E-B4A, hardening sección 17).

  Verifica assertSafeMigrationTarget() SIN Docker y SIN tocar ninguna BD:
  es una función pura que decide si el env que se le pasaría a
  run-migrations.js es seguro. Este test existe para que la protección en
  sí (no solo el integration test que la usa) quede cubierta por
  `npm test`, sin que npm test dependa de Docker.

  Uso: node scripts/check-checkout-finalization-mysql-guard.js
*/
const assert = require('assert');
const { assertSafeMigrationTarget, HOST_PORT, ROOT_PASSWORD, DB_NAME } = require('./check-checkout-finalization-mysql');

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }
function throws(fn, msg) {
  assert.throws(fn, msg);
  checks++;
}

function validEnv(overrides = {}) {
  return Object.assign({
    DB_HOST: '127.0.0.1', DB_PORT: String(HOST_PORT), DB_USER: 'root', DB_PASSWORD: ROOT_PASSWORD, DB_NAME
  }, overrides);
}

function main() {
  ok(assertSafeMigrationTarget(validEnv()) === true, 'un env correcto (host/puerto/credenciales del propio contenedor) debe aceptarse');

  throws(() => assertSafeMigrationTarget(validEnv({ DB_PORT: '3306' })), 'DB_PORT=3306 debe abortar SIEMPRE, aunque el resto coincida');
  throws(() => assertSafeMigrationTarget(validEnv({ DB_HOST: 'localhost' })), 'DB_HOST distinto de 127.0.0.1 debe abortar (incluso "localhost")');
  throws(() => assertSafeMigrationTarget(validEnv({ DB_HOST: 'db.produccion.example.com' })), 'un host remoto arbitrario debe abortar');
  throws(() => assertSafeMigrationTarget(validEnv({ DB_PORT: '3307' })), 'un puerto distinto al del contenedor de este script debe abortar');
  throws(() => assertSafeMigrationTarget(validEnv({ DB_USER: 'litum3d_user' })), 'un DB_USER distinto al root del contenedor debe abortar');
  throws(() => assertSafeMigrationTarget(validEnv({ DB_PASSWORD: 'otra-password' })), 'un DB_PASSWORD distinto al del contenedor debe abortar');
  throws(() => assertSafeMigrationTarget(validEnv({ DB_HOST: undefined })), 'DB_HOST ausente debe abortar');
  throws(() => assertSafeMigrationTarget(validEnv({ DB_PORT: '' })), 'DB_PORT vacío debe abortar');
  throws(() => assertSafeMigrationTarget(undefined), 'env completamente ausente debe abortar');
  throws(() => assertSafeMigrationTarget({}), 'env vacío debe abortar');

  // Caso específico del incidente real: DB_HOST/DB_PORT de .env (localhost:3306).
  throws(
    () => assertSafeMigrationTarget({ DB_HOST: 'localhost', DB_PORT: '3306', DB_USER: 'litum3d_user', DB_PASSWORD: 'x', DB_NAME: 'litum3d' }),
    'el env real que causó el incidente original (localhost:3306, litum3d_user) debe ser rechazado explícitamente'
  );

  console.log(`OK: ${checks} comprobaciones sobre la protección fail-closed del integration test MySQL.`);
}

main();
