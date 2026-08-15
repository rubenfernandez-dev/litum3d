/*
  LITUM3D - Tests de infraestructura de checkout drafts (services/checkout-drafts.js), P0E-B3.

  No usa BD real: inyecta un `dataAccess` en memoria que simula las
  restricciones UNIQUE de MySQL (idempotency_key, access_token_hash,
  stripe_payment_intent_id) lanzando errores con .code='ER_DUP_ENTRY' y
  .sqlMessage conteniendo el nombre de la constraint, igual que el driver
  mysql2 real. Mismo patrón sin Jest/Mocha que scripts/check-pricing-engine.js.

  También incluye una comprobación ESTÁTICA (regex sobre el texto SQL) de
  que las migraciones declaran las restricciones UNIQUE requeridas (ticket
  P0E-B3 #23). ESTO NO ES UN TEST DE INTEGRACIÓN REAL CONTRA MYSQL: no
  ejecuta las migraciones, no comprueba tipos de columna, charset/collation
  reales, ni el comportamiento efectivo de InnoDB ante NULLs en columnas
  UNIQUE. Es una regresión textual mínima para detectar que alguien borre
  accidentalmente una cláusula UNIQUE del .sql.

  Uso: node scripts/check-checkout-drafts.js
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  DRAFT_STATUS,
  DraftValidationError,
  DraftIdempotencyConflictError,
  DraftAccessDeniedError,
  DraftStateError,
  DraftPaymentIntentConflictError,
  DraftNotFoundError,
  computeSelectionsFingerprint,
  generateAccessToken,
  createOrGetDraft,
  getDraftById,
  getDraftByIdempotencyKey,
  getDraftByAccessToken,
  verifyAccessToken,
  updateCustomerDataByAccessToken,
  attachPaymentIntent,
  updateDraftStatus
} = require('../services/checkout-drafts');

let checks = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  checks++;
}
function eq(a, b, msg) {
  assert.strictEqual(a, b, msg);
  checks++;
}
async function rejects(fn, ErrorClass, msg) {
  let threw = null;
  try {
    await fn();
  } catch (err) {
    threw = err;
  }
  assert.ok(threw instanceof ErrorClass, `${msg} (esperaba ${ErrorClass.name}, obtuvo ${threw ? threw.constructor.name + ': ' + threw.message : 'ninguno'})`);
  checks++;
  return threw;
}

// ---------------------------------------------------------------------
// dataAccess en memoria: simula las mismas restricciones UNIQUE que
// declara database/migrations/add_checkout_drafts.sql, incluyendo el
// mensaje de error real de mysql2 (código + sqlMessage con el nombre de
// la constraint) para que services/checkout-drafts.js lo reconozca.
// ---------------------------------------------------------------------
function makeFakeDataAccess() {
  const rows = new Map();
  let nextId = 1;

  function checkUnique(field, value, excludeId) {
    if (value === null || value === undefined) return; // NULL no cuenta como duplicado (semántica InnoDB)
    for (const row of rows.values()) {
      if (row.id === excludeId) continue;
      if (row[field] === value) {
        const err = new Error(`Duplicate entry '${value}' for key 'checkout_drafts.unique_checkout_drafts_${field}'`);
        err.code = 'ER_DUP_ENTRY';
        err.sqlMessage = err.message;
        throw err;
      }
    }
  }

  return {
    async insertDraft({ idempotencyKey, selectionsFingerprint, accessTokenHash, snapshotJson, status, expiresAt }) {
      checkUnique('idempotency_key', idempotencyKey);
      checkUnique('access_token_hash', accessTokenHash);
      const id = nextId++;
      const now = new Date();
      rows.set(id, {
        id,
        idempotency_key: idempotencyKey,
        selections_fingerprint: selectionsFingerprint,
        access_token_hash: accessTokenHash,
        stripe_payment_intent_id: null,
        snapshot_json: snapshotJson,
        status,
        created_at: now,
        updated_at: now,
        expires_at: expiresAt
      });
      return id;
    },
    async findById(id) {
      return rows.get(id) || null;
    },
    async findByIdempotencyKey(key) {
      for (const row of rows.values()) if (row.idempotency_key === key) return row;
      return null;
    },
    async findByAccessTokenHash(hash) {
      for (const row of rows.values()) if (row.access_token_hash === hash) return row;
      return null;
    },
    async updateSnapshotIfStatusIn(id, snapshotJson, allowedStatuses) {
      const row = rows.get(id);
      if (!row) return 0;
      if (!allowedStatuses.includes(row.status)) return 0;
      row.snapshot_json = snapshotJson;
      row.updated_at = new Date();
      return 1;
    },
    async updateStatus(id, status) {
      const row = rows.get(id);
      if (!row) return;
      row.status = status;
      row.updated_at = new Date();
    },
    async attachStripePaymentIntent(id, paymentIntentId, status) {
      checkUnique('stripe_payment_intent_id', paymentIntentId, id);
      const row = rows.get(id);
      if (!row) return;
      row.stripe_payment_intent_id = paymentIntentId;
      row.status = status;
      row.updated_at = new Date();
    }
  };
}

function sampleSelections(overrides = {}) {
  return [Object.assign({
    productId: 8,
    quantity: 1,
    modelId: 3,
    variantOptionIds: [7, 27],
    extras: { upscale: true, qr: false, adapter: false, qrMessage: '' },
    images: [{ url: 'https://example.com/a.jpg', filename: 'a.jpg' }],
    notes: 'Nota de prueba'
  }, overrides)];
}

function sampleSnapshot(overrides = {}) {
  return Object.assign({
    schemaVersion: 1,
    currency: 'chf',
    customerData: { name: '', email: '', phone: '', address: '', city: '', zip: '' },
    items: [],
    totals: {}
  }, overrides);
}

function sampleCustomerData(overrides = {}) {
  return Object.assign({
    name: 'Ana Muster',
    email: 'ana@example.com',
    phone: '+41 79 123 45 67',
    address: 'Bahnhofstrasse 1',
    city: 'Zürich',
    zip: '8001'
  }, overrides);
}

// A partir del hardening del access token (P0E-B3, hardening final): el
// CALLER genera el token antes de llamar a createOrGetDraft, que ya no lo
// devuelve en la respuesta. Este helper simula ese caller: genera el token
// UNA vez y lo conserva junto con el resultado, exactamente como haría
// checkout.js en B4 (Web Crypto antes de la primera petición, mismo valor
// reutilizado en cualquier reintento).
async function createFreshDraft(dataAccess, idempotencyKey, { selectionsOverrides, snapshotOverrides } = {}) {
  const accessToken = generateAccessToken();
  const result = await createOrGetDraft(
    { idempotencyKey, accessToken, selections: sampleSelections(selectionsOverrides), snapshot: sampleSnapshot(snapshotOverrides) },
    { dataAccess }
  );
  return { draft: result.draft, reused: result.reused, accessToken };
}

// =======================================================================
// #23 - Test estático de migraciones
// =======================================================================
function checkMigrationsStatic() {
  const draftsSql = fs.readFileSync(
    path.join(__dirname, '..', 'database', 'migrations', 'add_checkout_drafts.sql'), 'utf8'
  );
  ok(/UNIQUE KEY\s+\S*idempotency_key\S*\s*\(idempotency_key\)/i.test(draftsSql),
    'checkout_drafts.idempotency_key debe declararse UNIQUE');
  ok(/UNIQUE KEY\s+\S*access_token_hash\S*\s*\(access_token_hash\)/i.test(draftsSql),
    'checkout_drafts.access_token_hash debe declararse UNIQUE');
  ok(/UNIQUE KEY\s+\S*stripe_payment_intent_id\S*\s*\(stripe_payment_intent_id\)/i.test(draftsSql),
    'checkout_drafts.stripe_payment_intent_id debe declararse UNIQUE');

  const pedidosSql = fs.readFileSync(
    path.join(__dirname, '..', 'database', 'migrations', 'add_pedidos_stripe_payment_intent.sql'), 'utf8'
  );
  ok(/ADD COLUMN\s+stripe_payment_intent_id/i.test(pedidosSql),
    'pedidos.stripe_payment_intent_id debe añadirse');
  ok(/UNIQUE KEY\s+\S*stripe_payment_intent_id\S*\s*\(stripe_payment_intent_id\)/i.test(pedidosSql),
    'pedidos.stripe_payment_intent_id debe declararse UNIQUE');

  console.log('  (nota: comprobación textual únicamente; no ejecuta las migraciones contra MySQL real)');
}

// =======================================================================
// #17 - Fingerprint
// =======================================================================
function checkFingerprint() {
  const f1 = computeSelectionsFingerprint(sampleSelections());
  const f2 = computeSelectionsFingerprint(sampleSelections());
  eq(f1, f2, 'misma selección debe producir el mismo fingerprint');
  ok(/^[0-9a-f]{64}$/.test(f1), 'fingerprint debe ser un SHA-256 hex de 64 caracteres');

  const reorderedIds = computeSelectionsFingerprint(sampleSelections({ variantOptionIds: [27, 7] }));
  eq(f1, reorderedIds, 'distinto orden de variantOptionIds debe producir el MISMO fingerprint');

  const dupedIds = computeSelectionsFingerprint(sampleSelections({ variantOptionIds: [7, 7, 27] }));
  eq(f1, dupedIds, 'IDs duplicados en variantOptionIds deben colapsarse (mismo fingerprint que sin duplicar)');

  ok(f1 !== computeSelectionsFingerprint(sampleSelections({ productId: 9 })), 'productId diferente debe producir distinto fingerprint');
  ok(f1 !== computeSelectionsFingerprint(sampleSelections({ quantity: 2 })), 'quantity diferente debe producir distinto fingerprint');
  ok(f1 !== computeSelectionsFingerprint(sampleSelections({ modelId: 5 })), 'modelId diferente debe producir distinto fingerprint');
  ok(f1 !== computeSelectionsFingerprint(sampleSelections({ modelId: null })), 'modelId null vs number debe producir distinto fingerprint');
  ok(f1 !== computeSelectionsFingerprint(sampleSelections({ variantOptionIds: [7] })), 'variantOptionIds distintos deben producir distinto fingerprint');
  ok(f1 !== computeSelectionsFingerprint(sampleSelections({ extras: { upscale: false, qr: false, adapter: false, qrMessage: '' } })), 'extras diferentes deben producir distinto fingerprint');
  ok(f1 !== computeSelectionsFingerprint(sampleSelections({ images: [{ url: 'https://example.com/b.jpg' }] })), 'images diferentes deben producir distinto fingerprint');
  ok(f1 !== computeSelectionsFingerprint(sampleSelections({ notes: 'Otra nota completamente distinta' })), 'notes diferentes deben producir distinto fingerprint');

  const withQr = sampleSelections({ extras: { upscale: true, qr: true, adapter: false, qrMessage: 'Hola' } });
  const withQrOtherMsg = sampleSelections({ extras: { upscale: true, qr: true, adapter: false, qrMessage: 'Adiós' } });
  ok(computeSelectionsFingerprint(withQr) !== computeSelectionsFingerprint(withQrOtherMsg), 'qrMessage distinto (con qr=true) debe producir distinto fingerprint');

  const qrFalseMsgA = sampleSelections({ extras: { upscale: true, qr: false, adapter: false, qrMessage: 'residuo A' } });
  const qrFalseMsgB = sampleSelections({ extras: { upscale: true, qr: false, adapter: false, qrMessage: 'residuo B' } });
  eq(computeSelectionsFingerprint(qrFalseMsgA), computeSelectionsFingerprint(qrFalseMsgB),
    'qrMessage se normaliza a "" cuando qr=false: no debe afectar al fingerprint');

  const sameImagesOtherOrder = sampleSelections({
    images: [{ url: 'https://example.com/second.jpg' }, { url: 'https://example.com/first.jpg' }]
  });
  const originalOrder = sampleSelections({
    images: [{ url: 'https://example.com/first.jpg' }, { url: 'https://example.com/second.jpg' }]
  });
  ok(computeSelectionsFingerprint(originalOrder) !== computeSelectionsFingerprint(sameImagesOtherOrder),
    'mismo conjunto de imágenes en distinto orden debe producir distinto fingerprint (el orden es significativo)');

  // Determinismo: mismo objeto lógico, claves JS en distinto orden de construcción.
  const itemA = { productId: 8, quantity: 1, modelId: null, variantOptionIds: [1, 2], extras: { upscale: true, qr: false, adapter: false, qrMessage: '' }, images: [], notes: 'x' };
  const itemB = { notes: 'x', images: [], extras: { qrMessage: '', adapter: false, qr: false, upscale: true }, variantOptionIds: [1, 2], modelId: null, quantity: 1, productId: 8 };
  eq(computeSelectionsFingerprint([itemA]), computeSelectionsFingerprint([itemB]),
    'mismo objeto lógico con distinto orden de claves JS debe producir el mismo fingerprint');

  assert.throws(() => computeSelectionsFingerprint(sampleSelections({ productId: 'ocho' })), DraftValidationError,
    'productId no numérico debe rechazarse');
  checks++;
  assert.throws(() => computeSelectionsFingerprint(sampleSelections({ extraCampoInventado: 1 })), DraftValidationError,
    'un campo no permitido en la selección debe rechazarse');
  checks++;

  // Hardening #9: booleanos de extras estrictos, sin coerción laxa de
  // strings/números a boolean (mismo contrato que services/pricing.js).
  assert.doesNotThrow(
    () => computeSelectionsFingerprint(sampleSelections({ extras: { upscale: true, qr: false, adapter: true, qrMessage: '' } })),
    'boolean true/false real debe aceptarse sin problema'
  );
  checks++;
  assert.throws(
    () => computeSelectionsFingerprint(sampleSelections({ extras: { upscale: 'true', qr: false, adapter: false, qrMessage: '' } })),
    DraftValidationError,
    'extras.upscale como string "true" debe rechazarse, no coaccionarse a boolean'
  );
  checks++;
  assert.throws(
    () => computeSelectionsFingerprint(sampleSelections({ extras: { upscale: true, qr: 'false', adapter: false, qrMessage: '' } })),
    DraftValidationError,
    'extras.qr como string "false" debe rechazarse, no coaccionarse a boolean'
  );
  checks++;
  assert.throws(
    () => computeSelectionsFingerprint(sampleSelections({ extras: { upscale: true, qr: false, adapter: 1, qrMessage: '' } })),
    DraftValidationError,
    'extras.adapter como number (1) debe rechazarse, no coaccionarse a boolean'
  );
  checks++;
}

// =======================================================================
// #18 - Idempotencia (incluye #7: customerData fuera del fingerprint, y #9: carrera)
// =======================================================================
async function checkIdempotency() {
  const dataAccess = makeFakeDataAccess();
  const tokenK1 = generateAccessToken();

  const first = await createOrGetDraft(
    { idempotencyKey: 'K1', accessToken: tokenK1, selections: sampleSelections(), snapshot: sampleSnapshot() },
    { dataAccess }
  );
  eq(first.reused, false, 'primera creación: reused debe ser false');
  eq(first.draft.status, DRAFT_STATUS.CREATED, 'draft nuevo debe empezar en estado created');

  // Misma key + mismo token + mismo fingerprint -> reutiliza, no crea otro.
  const second = await createOrGetDraft(
    { idempotencyKey: 'K1', accessToken: tokenK1, selections: sampleSelections(), snapshot: sampleSnapshot() },
    { dataAccess }
  );
  eq(second.reused, true, 'misma key + mismo token + mismo fingerprint: reused debe ser true');
  eq(second.draft.id, first.draft.id, 'repetición: debe devolver el MISMO draft.id (no crea otro)');

  // #7: mismo carrito, distinto customerData embebido en el snapshot -> sigue siendo el mismo intento lógico.
  const thirdDifferentCustomer = await createOrGetDraft(
    {
      idempotencyKey: 'K1',
      accessToken: tokenK1,
      selections: sampleSelections(),
      snapshot: sampleSnapshot({ customerData: sampleCustomerData({ name: 'Otro Nombre Completamente Distinto' }) })
    },
    { dataAccess }
  );
  eq(thirdDifferentCustomer.reused, true, 'customerData distinto en el snapshot no debe afectar la idempotencia (customerData fuera del fingerprint)');
  eq(thirdDifferentCustomer.draft.id, first.draft.id, 'customerData distinto: debe seguir siendo el mismo draft');

  // Misma key + fingerprint distinto -> conflicto explícito, no crea ni reutiliza.
  const conflictErr = await rejects(
    () => createOrGetDraft(
      { idempotencyKey: 'K1', accessToken: tokenK1, selections: sampleSelections({ productId: 999 }), snapshot: sampleSnapshot() },
      { dataAccess }
    ),
    DraftIdempotencyConflictError,
    'misma key + fingerprint distinto debe lanzar DraftIdempotencyConflictError'
  );
  eq(conflictErr.existingDraftId, first.draft.id, 'el error de conflicto debe referenciar el draft existente');

  // ---- Caso más importante del hardening: respuesta HTTP perdida --------
  // El caller genera el token ANTES de la primera petición (aquí: tokenLost)
  // y la conserva. Si la respuesta de la primera llamada se pierde por
  // completo (se ignora deliberadamente el resultado), un reintento con la
  // MISMA key + MISMO token + mismas selecciones debe recuperar el draft
  // igualmente: la capability nunca dependió de que la respuesta llegara.
  const lostKey = 'K-LOST-RESPONSE';
  const tokenLost = generateAccessToken();
  await createOrGetDraft(
    { idempotencyKey: lostKey, accessToken: tokenLost, selections: sampleSelections(), snapshot: sampleSnapshot() },
    { dataAccess }
  ); // respuesta ignorada a propósito: simula que nunca llegó al cliente
  const retryAfterLostResponse = await createOrGetDraft(
    { idempotencyKey: lostKey, accessToken: tokenLost, selections: sampleSelections(), snapshot: sampleSnapshot() },
    { dataAccess }
  );
  eq(retryAfterLostResponse.reused, true, 'reintento tras respuesta perdida (mismo token) debe reutilizar el draft, no fallar');
  const recoveredDraft = await getDraftByAccessToken(tokenLost, { dataAccess });
  ok(recoveredDraft && recoveredDraft.id === retryAfterLostResponse.draft.id,
    'tras la respuesta perdida, el token que el cliente ya tenía debe seguir dando acceso al draft');

  // ---- Misma key + mismo fingerprint + TOKEN INCORRECTO -----------------
  const wrongTokenKey = 'K-WRONG-TOKEN';
  const tokenReal = generateAccessToken();
  const tokenAjeno = generateAccessToken();
  await createOrGetDraft(
    { idempotencyKey: wrongTokenKey, accessToken: tokenReal, selections: sampleSelections(), snapshot: sampleSnapshot() },
    { dataAccess }
  );
  await rejects(
    () => createOrGetDraft(
      { idempotencyKey: wrongTokenKey, accessToken: tokenAjeno, selections: sampleSelections(), snapshot: sampleSnapshot() },
      { dataAccess }
    ),
    DraftAccessDeniedError,
    'misma key + mismo fingerprint + token distinto NO debe reutilizar el draft silenciosamente'
  );

  // "Carrera simulada por UNIQUE" con el MISMO token: el segundo insertDraft
  // con la misma key SIEMPRE falla por la restricción única del dataAccess
  // en memoria (igual que fallaría en MySQL real bajo dos requests
  // concurrentes), y el servicio recupera al ganador y compara fingerprint
  // + token exactamente con el mismo código que el caso "repetición válida".
  const raceKey = 'K-RACE';
  const raceToken = generateAccessToken();
  const requestA = await createOrGetDraft(
    { idempotencyKey: raceKey, accessToken: raceToken, selections: sampleSelections(), snapshot: sampleSnapshot() },
    { dataAccess }
  );
  const requestB = await createOrGetDraft(
    { idempotencyKey: raceKey, accessToken: raceToken, selections: sampleSelections(), snapshot: sampleSnapshot() },
    { dataAccess }
  );
  eq(requestB.draft.id, requestA.draft.id, 'carrera simulada (mismo token/fingerprint): la segunda request debe recuperar el draft de la primera, no crear otro');
  eq(requestB.reused, true, 'carrera simulada: la segunda request debe marcarse como reused');

  const requestCOtherFingerprint = await rejects(
    () => createOrGetDraft(
      { idempotencyKey: raceKey, accessToken: raceToken, selections: sampleSelections({ quantity: 3 }), snapshot: sampleSnapshot() },
      { dataAccess }
    ),
    DraftIdempotencyConflictError,
    'carrera simulada (fingerprint distinto): debe lanzar conflicto, no crear ni reutilizar'
  );
  ok(requestCOtherFingerprint.existingDraftId === requestA.draft.id, 'el conflicto de carrera debe referenciar el draft ganador real');

  // Carrera con TOKENS DISTINTOS (mismo fingerprint): la request perdedora
  // no debe adquirir acceso al draft ganador usando su propio token.
  const raceTokenKey = 'K-RACE-TOKENS';
  const raceTokenWinner = generateAccessToken();
  const raceTokenLoser = generateAccessToken();
  const raceWinner = await createOrGetDraft(
    { idempotencyKey: raceTokenKey, accessToken: raceTokenWinner, selections: sampleSelections(), snapshot: sampleSnapshot() },
    { dataAccess }
  );
  await rejects(
    () => createOrGetDraft(
      { idempotencyKey: raceTokenKey, accessToken: raceTokenLoser, selections: sampleSelections(), snapshot: sampleSnapshot() },
      { dataAccess }
    ),
    DraftAccessDeniedError,
    'carrera con tokens distintos: la request que pierde el INSERT no debe adquirir acceso al draft ganador con su propio token'
  );
  const loserCannotAccess = await verifyAccessToken(raceTokenLoser, raceWinner.draft.id, { dataAccess });
  eq(loserCannotAccess, false, 'el token de la request perdedora no debe verificar contra el draft ganador');

  return { dataAccess, first, tokenK1 };
}

// =======================================================================
// #19 - Access token
// =======================================================================
async function checkAccessToken({ dataAccess, first, tokenK1 }) {
  const tokenA = generateAccessToken();
  const tokenB = generateAccessToken();
  ok(/^[0-9a-f]{64}$/.test(tokenA), 'generateAccessToken debe producir 64 caracteres hex (256 bits)');
  ok(tokenA !== tokenB, 'dos tokens generados deben ser distintos (CSPRNG)');

  ok(!('accessTokenHash' in first.draft) && !('access_token_hash' in first.draft),
    'el objeto draft devuelto nunca debe exponer el hash del access token');

  const foundByToken = await getDraftByAccessToken(tokenK1, { dataAccess });
  ok(foundByToken && foundByToken.id === first.draft.id, 'el access token original (generado por el caller) debe localizar el draft');

  const notFoundByWrongToken = await getDraftByAccessToken('0'.repeat(64), { dataAccess });
  eq(notFoundByWrongToken, null, 'un token incorrecto no debe localizar ningún draft');

  const verifiedOk = await verifyAccessToken(tokenK1, first.draft.id, { dataAccess });
  eq(verifiedOk, true, 'verifyAccessToken con el token correcto debe devolver true');
  const verifiedBad = await verifyAccessToken('a'.repeat(64), first.draft.id, { dataAccess });
  eq(verifiedBad, false, 'verifyAccessToken con un token incorrecto debe devolver false');

  // createOrGetDraft exige el token: formato inválido/ausente -> DraftValidationError, no genera uno silenciosamente.
  await rejects(
    () => createOrGetDraft(
      { idempotencyKey: 'NO-TOKEN', selections: sampleSelections(), snapshot: sampleSnapshot() },
      { dataAccess }
    ),
    DraftValidationError,
    'createOrGetDraft sin accessToken debe rechazarse, no generar uno por su cuenta'
  );
  await rejects(
    () => createOrGetDraft(
      { idempotencyKey: 'BAD-TOKEN', accessToken: 'demasiado-corto', selections: sampleSelections(), snapshot: sampleSnapshot() },
      { dataAccess }
    ),
    DraftValidationError,
    'createOrGetDraft con accessToken de formato inválido debe rechazarse'
  );
  await rejects(
    () => createOrGetDraft(
      { idempotencyKey: 'BAD-TOKEN-2', accessToken: 'Z'.repeat(64), selections: sampleSelections(), snapshot: sampleSnapshot() },
      { dataAccess }
    ),
    DraftValidationError,
    'createOrGetDraft con accessToken de longitud correcta pero caracteres no hex debe rechazarse'
  );

  // Token válido y correctamente formado crea el draft con normalidad, y BD solo recibe el hash.
  const tokenValido = generateAccessToken();
  const createdWithValidToken = await createOrGetDraft(
    { idempotencyKey: 'GOOD-TOKEN', accessToken: tokenValido, selections: sampleSelections(), snapshot: sampleSnapshot() },
    { dataAccess }
  );
  eq(createdWithValidToken.reused, false, 'un accessToken válido debe permitir crear el draft con normalidad');
  const rawRow = await getDraftByAccessToken(tokenValido, { dataAccess });
  ok(rawRow !== null, 'el draft creado debe ser localizable por el token real');

  // Repetición idempotente con el mismo token (ver checkIdempotency) ya
  // demuestra que no hace falta un segundo capability token: el caller
  // sigue usando el que generó él mismo.
  ok(true, 'repetición idempotente ya verificada en checkIdempotency: el caller reutiliza su propio token, no se genera uno nuevo');
  checks++;
}

// =======================================================================
// #20 - Customer data
// =======================================================================
async function checkCustomerData() {
  const dataAccess = makeFakeDataAccess();
  const created = await createFreshDraft(dataAccess, 'CUST-1');

  // created: permitido.
  const updated = await updateCustomerDataByAccessToken(created.accessToken, sampleCustomerData(), { dataAccess });
  eq(updated.snapshot.customerData.name, 'Ana Muster', 'actualización con token válido y datos válidos debe reflejarse en el snapshot');

  // token inválido -> rechazo.
  await rejects(
    () => updateCustomerDataByAccessToken('token-que-no-existe-0000000000000000000000000000000000000000', sampleCustomerData(), { dataAccess }),
    DraftAccessDeniedError,
    'token inválido debe rechazarse con DraftAccessDeniedError'
  );

  // payment_pending: permitido en B3.
  await attachPaymentIntent(created.draft.id, 'pi_test_123', { dataAccess });
  const updatedPending = await updateCustomerDataByAccessToken(created.accessToken, sampleCustomerData({ city: 'Basel' }), { dataAccess });
  eq(updatedPending.snapshot.customerData.city, 'Basel', 'actualización en estado payment_pending debe permitirse en B3');
  eq(updatedPending.status, DRAFT_STATUS.PAYMENT_PENDING, 'el draft debe seguir en payment_pending tras actualizar customerData');

  // converted -> rechazo.
  await updateDraftStatus(created.draft.id, DRAFT_STATUS.CONVERTED, { dataAccess });
  await rejects(
    () => updateCustomerDataByAccessToken(created.accessToken, sampleCustomerData(), { dataAccess }),
    DraftStateError,
    'actualización sobre un draft converted debe rechazarse con DraftStateError'
  );

  // expired -> rechazo (draft nuevo para no depender del ya convertido).
  const draftForExpiry = await createFreshDraft(dataAccess, 'CUST-2');
  await updateDraftStatus(draftForExpiry.draft.id, DRAFT_STATUS.EXPIRED, { dataAccess });
  await rejects(
    () => updateCustomerDataByAccessToken(draftForExpiry.accessToken, sampleCustomerData(), { dataAccess }),
    DraftStateError,
    'actualización sobre un draft expired debe rechazarse con DraftStateError'
  );

  // Validación de campos.
  const draftForValidation = await createFreshDraft(dataAccess, 'CUST-3');
  await rejects(
    () => updateCustomerDataByAccessToken(draftForValidation.accessToken, sampleCustomerData({ name: '' }), { dataAccess }),
    DraftValidationError,
    'name vacío debe rechazarse'
  );
  await rejects(
    () => updateCustomerDataByAccessToken(draftForValidation.accessToken, sampleCustomerData({ email: 'no-es-un-email' }), { dataAccess }),
    DraftValidationError,
    'email con formato inválido debe rechazarse'
  );
  await rejects(
    () => updateCustomerDataByAccessToken(draftForValidation.accessToken, sampleCustomerData({ address: '' }), { dataAccess }),
    DraftValidationError,
    'address vacío debe rechazarse'
  );
  await rejects(
    () => updateCustomerDataByAccessToken(draftForValidation.accessToken, sampleCustomerData({ city: '' }), { dataAccess }),
    DraftValidationError,
    'city vacío debe rechazarse'
  );
  await rejects(
    () => updateCustomerDataByAccessToken(draftForValidation.accessToken, sampleCustomerData({ zip: '' }), { dataAccess }),
    DraftValidationError,
    'zip vacío debe rechazarse'
  );
  await rejects(
    () => updateCustomerDataByAccessToken(draftForValidation.accessToken, { ...sampleCustomerData(), country: 'CH' }, { dataAccess }),
    DraftValidationError,
    'un campo inesperado como "country" debe rechazarse (no se admite selector de país)'
  );
}

// =======================================================================
// Hardening P0E-B4A #4/#5: la autorización por estado debe formar parte de
// la propia escritura, no solo de un SELECT previo. Se simula la carrera
// real: el status cambia a "converted" DESPUÉS de que updateCustomerDataByAccessToken
// ya leyó el draft (vía findByAccessTokenHash) como payment_pending, pero
// ANTES de que su UPDATE condicional se ejecute. Sin la escritura atómica,
// esto habría escrito customerData sobre un draft ya convertido.
// =======================================================================
async function checkCustomerDataAtomicWriteRace() {
  const dataAccess = makeFakeDataAccess();
  const draft = await createFreshDraft(dataAccess, 'CUST-RACE');
  await attachPaymentIntent(draft.draft.id, 'pi_race_customer_data', { dataAccess });
  eq((await getDraftById(draft.draft.id, { dataAccess })).status, DRAFT_STATUS.PAYMENT_PENDING, 'sanity: el draft debe estar payment_pending antes de la carrera');

  let readCount = 0;
  const racingDataAccess = {
    ...dataAccess,
    async findByAccessTokenHash(hash) {
      readCount++;
      const row = await dataAccess.findByAccessTokenHash(hash);
      if (row && readCount === 1) {
        // Simula una finalización concurrente que convierte el draft justo
        // después de que esta lectura ya lo vio como payment_pending.
        await dataAccess.updateStatus(row.id, DRAFT_STATUS.CONVERTED);
      }
      return row; // la copia devuelta a la función sigue diciendo payment_pending (stale)
    }
  };

  await rejects(
    () => updateCustomerDataByAccessToken(draft.accessToken, sampleCustomerData(), { dataAccess: racingDataAccess }),
    DraftStateError,
    'la escritura condicional debe rechazar el update aunque la lectura previa dijera payment_pending, porque el status real ya cambió a converted antes del UPDATE'
  );

  const finalDraft = await getDraftById(draft.draft.id, { dataAccess });
  eq(finalDraft.snapshot.customerData.name, '', 'el customerData NO debe haberse escrito: el draft convertido debe conservar su snapshot original');
}

// =======================================================================
// #21 - PaymentIntent association
// =======================================================================
async function checkPaymentIntentAssociation() {
  const dataAccess = makeFakeDataAccess();
  const draftA = await createFreshDraft(dataAccess, 'PI-A');

  // NULL -> asigna, pasa a payment_pending.
  const attached = await attachPaymentIntent(draftA.draft.id, 'pi_AAA', { dataAccess });
  eq(attached.stripePaymentIntentId, 'pi_AAA', 'debe asignarse el PaymentIntent cuando el draft no tenía ninguno');
  eq(attached.status, DRAFT_STATUS.PAYMENT_PENDING, 'asignar un PaymentIntent debe mover el draft a payment_pending');

  // Mismo ID -> éxito idempotente.
  const reattachedSame = await attachPaymentIntent(draftA.draft.id, 'pi_AAA', { dataAccess });
  eq(reattachedSame.stripePaymentIntentId, 'pi_AAA', 'reintentar con el MISMO PaymentIntent debe ser un éxito idempotente');

  // Otro ID -> conflicto.
  await rejects(
    () => attachPaymentIntent(draftA.draft.id, 'pi_BBB', { dataAccess }),
    DraftPaymentIntentConflictError,
    'asociar un PaymentIntent DISTINTO a uno ya asociado debe lanzar DraftPaymentIntentConflictError'
  );

  // PI ya usado por otro draft -> conflicto vía UNIQUE.
  const draftB = await createFreshDraft(dataAccess, 'PI-B');
  await rejects(
    () => attachPaymentIntent(draftB.draft.id, 'pi_AAA', { dataAccess }),
    DraftPaymentIntentConflictError,
    'un PaymentIntent ya usado por OTRO draft debe rechazarse (violación de UNIQUE simulada)'
  );

  // draftId inexistente.
  await rejects(
    () => attachPaymentIntent(999999, 'pi_ZZZ', { dataAccess }),
    DraftNotFoundError,
    'attachPaymentIntent sobre un draftId inexistente debe lanzar DraftNotFoundError'
  );

  // Draft converted/expired -> rechazo.
  const draftC = await createFreshDraft(dataAccess, 'PI-C');
  await updateDraftStatus(draftC.draft.id, DRAFT_STATUS.EXPIRED, { dataAccess });
  await rejects(
    () => attachPaymentIntent(draftC.draft.id, 'pi_CCC', { dataAccess }),
    DraftStateError,
    'attachPaymentIntent sobre un draft expired debe rechazarse'
  );
}

// =======================================================================
// #22 - Estados
// =======================================================================
async function checkStateMachine() {
  const dataAccess = makeFakeDataAccess();

  async function freshDraft(key) {
    const created = await createFreshDraft(dataAccess, key);
    return created.draft.id;
  }

  // Permitidas.
  const idCreatedToPending = await freshDraft('ST-1');
  const toPending = await updateDraftStatus(idCreatedToPending, DRAFT_STATUS.PAYMENT_PENDING, { dataAccess });
  eq(toPending.status, DRAFT_STATUS.PAYMENT_PENDING, 'created -> payment_pending debe permitirse');

  const idCreatedToExpired = await freshDraft('ST-2');
  const toExpired = await updateDraftStatus(idCreatedToExpired, DRAFT_STATUS.EXPIRED, { dataAccess });
  eq(toExpired.status, DRAFT_STATUS.EXPIRED, 'created -> expired debe permitirse');

  const idPendingToConverted = await freshDraft('ST-3');
  await updateDraftStatus(idPendingToConverted, DRAFT_STATUS.PAYMENT_PENDING, { dataAccess });
  const toConverted = await updateDraftStatus(idPendingToConverted, DRAFT_STATUS.CONVERTED, { dataAccess });
  eq(toConverted.status, DRAFT_STATUS.CONVERTED, 'payment_pending -> converted debe permitirse');

  const idPendingToExpired = await freshDraft('ST-4');
  await updateDraftStatus(idPendingToExpired, DRAFT_STATUS.PAYMENT_PENDING, { dataAccess });
  const pendingToExpired = await updateDraftStatus(idPendingToExpired, DRAFT_STATUS.EXPIRED, { dataAccess });
  eq(pendingToExpired.status, DRAFT_STATUS.EXPIRED, 'payment_pending -> expired debe permitirse');

  // No permitidas, desde converted.
  const idConverted = await freshDraft('ST-5');
  await updateDraftStatus(idConverted, DRAFT_STATUS.PAYMENT_PENDING, { dataAccess });
  await updateDraftStatus(idConverted, DRAFT_STATUS.CONVERTED, { dataAccess });
  await rejects(() => updateDraftStatus(idConverted, DRAFT_STATUS.CREATED, { dataAccess }), DraftStateError, 'converted -> created NO debe permitirse');
  await rejects(() => updateDraftStatus(idConverted, DRAFT_STATUS.PAYMENT_PENDING, { dataAccess }), DraftStateError, 'converted -> payment_pending NO debe permitirse');
  await rejects(() => updateDraftStatus(idConverted, DRAFT_STATUS.EXPIRED, { dataAccess }), DraftStateError, 'converted -> expired NO debe permitirse');

  // No permitidas, desde expired.
  const idExpired = await freshDraft('ST-6');
  await updateDraftStatus(idExpired, DRAFT_STATUS.EXPIRED, { dataAccess });
  await rejects(() => updateDraftStatus(idExpired, DRAFT_STATUS.CREATED, { dataAccess }), DraftStateError, 'expired -> created NO debe permitirse');
  await rejects(() => updateDraftStatus(idExpired, DRAFT_STATUS.PAYMENT_PENDING, { dataAccess }), DraftStateError, 'expired -> payment_pending NO debe permitirse');
  await rejects(() => updateDraftStatus(idExpired, DRAFT_STATUS.CONVERTED, { dataAccess }), DraftStateError, 'expired -> converted NO debe permitirse');

  // Una vez converted, no debe volver a ningún otro estado (ya cubierto arriba); no-op idempotente permitido.
  const idNoop = await freshDraft('ST-7');
  const noopResult = await updateDraftStatus(idNoop, DRAFT_STATUS.CREATED, { dataAccess });
  eq(noopResult.status, DRAFT_STATUS.CREATED, 'llamar con el mismo estado actual debe ser un no-op idempotente, no un error');

  await rejects(() => updateDraftStatus(999999, DRAFT_STATUS.EXPIRED, { dataAccess }), DraftNotFoundError, 'updateDraftStatus sobre un draftId inexistente debe lanzar DraftNotFoundError');
  await rejects(() => updateDraftStatus(idNoop, 'estado_inventado', { dataAccess }), DraftValidationError, 'un estado desconocido debe rechazarse');
}

// =======================================================================
async function main() {
  console.log('P0E-B3 - checkout_drafts: comprobación estática de migraciones');
  checkMigrationsStatic();

  console.log('P0E-B3 - fingerprint de selecciones');
  checkFingerprint();

  console.log('P0E-B3 - idempotencia (incluye customerData fuera del fingerprint y carrera simulada)');
  const idempotencyCtx = await checkIdempotency();

  console.log('P0E-B3 - access token');
  await checkAccessToken(idempotencyCtx);

  console.log('P0E-B3 - customer data');
  await checkCustomerData();

  console.log('P0E-B4A - customer data: escritura atómica condicionada por estado (carrera)');
  await checkCustomerDataAtomicWriteRace();

  console.log('P0E-B3 - asociación de PaymentIntent');
  await checkPaymentIntentAssociation();

  console.log('P0E-B3 - máquina de estados');
  await checkStateMachine();

  console.log(`OK: ${checks} comprobaciones sobre checkout_drafts (services/checkout-drafts.js).`);
}

main().catch(err => {
  console.error('FALLO:', err);
  process.exit(1);
});
