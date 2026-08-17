/*
  LITUM3D - Test de la protección "fail closed" del integration test MySQL del
  session store (P0-SECURITY-01, hardening final). Mismo patrón que
  scripts/check-checkout-finalization-mysql-guard.js: verifica
  assertSafeMigrationTarget() SIN Docker y SIN tocar ninguna BD, para que la
  protección quede cubierta por `npm test` sin que npm test dependa de Docker.

  Uso: node scripts/check-session-store-mysql-guard.js
*/
const assert = require('assert');
const { assertSafeMigrationTarget, HOST_PORT, ROOT_PASSWORD, DB_NAME } = require('./check-session-store-mysql');

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }
function throws(fn, msg) { assert.throws(fn, msg); checks++; }

function validEnv(overrides = {}) {
  return Object.assign({ DB_HOST: '127.0.0.1', DB_PORT: String(HOST_PORT), DB_USER: 'root', DB_PASSWORD: ROOT_PASSWORD, DB_NAME }, overrides);
}

function main() {
  ok(assertSafeMigrationTarget(validEnv()) === true, 'un env correcto (host/puerto/credenciales del propio contenedor) debe aceptarse');

  throws(() => assertSafeMigrationTarget(validEnv({ DB_PORT: '3306' })), 'DB_PORT=3306 debe abortar SIEMPRE');
  throws(() => assertSafeMigrationTarget(validEnv({ DB_HOST: 'localhost' })), 'DB_HOST distinto de 127.0.0.1 debe abortar (incluso "localhost")');
  throws(() => assertSafeMigrationTarget(validEnv({ DB_HOST: 'db.produccion.example.com' })), 'un host remoto arbitrario debe abortar');
  throws(() => assertSafeMigrationTarget(validEnv({ DB_PORT: '33062' })), 'el puerto de OTRO integration test (checkout finalization) tampoco vale aquí');
  throws(() => assertSafeMigrationTarget(validEnv({ DB_USER: 'litum3d_user' })), 'un DB_USER distinto al root del contenedor debe abortar');
  throws(() => assertSafeMigrationTarget(validEnv({ DB_PASSWORD: 'otra-password' })), 'un DB_PASSWORD distinto al del contenedor debe abortar');
  throws(() => assertSafeMigrationTarget(validEnv({ DB_HOST: undefined })), 'DB_HOST ausente debe abortar');
  throws(() => assertSafeMigrationTarget(validEnv({ DB_PORT: '' })), 'DB_PORT vacío debe abortar');
  throws(() => assertSafeMigrationTarget(undefined), 'env completamente ausente debe abortar');
  throws(() => assertSafeMigrationTarget({}), 'env vacío debe abortar');

  throws(
    () => assertSafeMigrationTarget({ DB_HOST: 'localhost', DB_PORT: '3306', DB_USER: 'litum3d_user', DB_PASSWORD: 'x', DB_NAME: 'litum3d' }),
    'un env real de producción (localhost:3306) debe ser rechazado explícitamente'
  );

  console.log(`OK: ${checks} comprobaciones sobre la protección fail-closed del integration test MySQL del session store.`);
}

main();
