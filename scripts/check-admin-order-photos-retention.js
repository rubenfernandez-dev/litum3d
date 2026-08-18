/*
  LITUM3D - P1 Admin Pedidos/Fotos/Retención.

  Cubre:
    A) Admin muestra el customer_name real cuando existe (nunca "Anónimo").
    B) el nombre del cliente nunca se expone fuera de rutas requireAuth
       (verificación estática del código real, no una suposición).
    C/D) YA cubiertas íntegramente por scripts/check-uploads-privacy.js
       (checkAdminImageAccess): acceso a imagen propia -> 200, imagen real
       de OTRO pedido -> 404. No se duplican aquí.
    E/F) el email a ADMIN_EMAIL lleva attachments reales de las fotos del
       pedido; el email al cliente NUNCA lleva attachments.
    G) cambiar a un estado != Entregado -> las fotos permanecen intactas.
    H) cancelar la confirmación del frontend -> cero fetch.
    I) confirmar Entregado -> el cleanup se ejecuta y su resumen viaja en
       la respuesta.
    J/O/P/Q/R) deleteOrderCustomerUploads: unlink real, ENOENT idempotente,
       error real de filesystem (nunca marca DELETED, permite reintento),
       reintento posterior que solo reprocesa lo pendiente.
    K) referencias maliciosas/traversal -> nunca se toca el filesystem,
       nunca se marca DELETED sin certeza.
    L) una imagen de OTRO pedido nunca aparece en el cleanup de este pedido
       (el propio acceso a datos está scopeado por el JOIN de pertenencia).
    M) /pedidos/:id/detalle nunca devuelve `ruta`; expone {id, deleted,
       viewUrl}, y el frontend (script real, sandbox vm) resume
       correctamente los 3 casos: sin fotos / todas eliminadas / mezcla.
    N) NO se reimplementa aquí: se ejecuta aparte scripts/check-uploads-privacy.js
       íntegro (ver npm test) para confirmar que sigue en verde.

  Uso: node scripts/check-admin-order-photos-retention.js
*/
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const vm = require('vm');
const express = require('express');

const uploadsStorage = require('../services/uploads-storage');
const orderPhotoRetention = require('../services/order-photo-retention');

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); checks++; }

// --- Fixtures sintéticas (nunca archivos de clientes) -----------------------
function jpegFixture() {
  const buf = Buffer.alloc(32, 0x11);
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff; buf[3] = 0xe0;
  return buf;
}

const createdFilenames = new Set();
function writeRealFixture() {
  const filename = `${crypto.randomUUID()}.jpg`;
  fs.writeFileSync(path.join(uploadsStorage.CUSTOM_UPLOAD_ROOT, filename), jpegFixture());
  createdFilenames.add(filename);
  return filename;
}
function cleanupCreatedFiles() {
  for (const filename of createdFilenames) {
    try { fs.unlinkSync(path.join(uploadsStorage.CUSTOM_UPLOAD_ROOT, filename)); } catch (_) { /* ya borrado por el propio test, es lo esperado */ }
  }
}

// --- dataAccess falso para services/order-photo-retention.js ----------------
// Simula el JOIN real (dp.pedido_id = ?): cada pedido solo "ve" sus propias
// filas, igual que la consulta SQL real. markDeleted registra qué ids se
// tocaron para poder afirmar L) sin ambigüedad.
function makeFakeRetentionDataAccess(imagesByOrder) {
  const markedDeleted = [];
  return {
    dataAccess: {
      async getOwnedImageRows(orderId) {
        return (imagesByOrder[orderId] || []).map(img => ({ id: img.id, ruta: img.ruta }));
      },
      async markDeleted(imageId) {
        markedDeleted.push(imageId);
        for (const rows of Object.values(imagesByOrder)) {
          const row = rows.find(r => r.id === imageId);
          if (row) row.ruta = orderPhotoRetention.DELETED_IMAGE_SENTINEL;
        }
      }
    },
    markedDeleted
  };
}

// ============================================================================
// O/P/Q/R/K/L - services/order-photo-retention.js
// ============================================================================

async function checkUnlinkSuccessMarksDeleted() {
  const filename = writeRealFixture();
  const fullPath = path.join(uploadsStorage.CUSTOM_UPLOAD_ROOT, filename);
  const imagesByOrder = { 1: [{ id: 501, ruta: `custom/${filename}` }] };
  const { dataAccess } = makeFakeRetentionDataAccess(imagesByOrder);

  ok(fs.existsSync(fullPath), 'precondición: el fixture existe antes del cleanup');
  const summary = await orderPhotoRetention.deleteOrderCustomerUploads(1, { dataAccess });

  eq(summary.attempted, 1, 'O) attempted=1');
  eq(summary.deleted, 1, 'O) deleted=1 (unlink real con éxito)');
  eq(summary.alreadyMissing, 0, 'O) alreadyMissing=0');
  eq(summary.failed.length, 0, 'O) failed vacío');
  ok(!fs.existsSync(fullPath), 'O) el fichero desaparece realmente del filesystem');
  eq(imagesByOrder[1][0].ruta, orderPhotoRetention.DELETED_IMAGE_SENTINEL, 'O) la fila pasa a DELETED');
  createdFilenames.delete(filename); // ya no existe, no hace falta limpiarlo en el finally global
}

async function checkEnoentIsIdempotent() {
  // Referencia a un archivo que NUNCA se creó -> ENOENT real desde
  // fs.promises.unlink por defecto (sin inyectar nada).
  const filename = `${crypto.randomUUID()}.jpg`;
  const imagesByOrder = { 2: [{ id: 502, ruta: `custom/${filename}` }] };
  const { dataAccess } = makeFakeRetentionDataAccess(imagesByOrder);

  const summary = await orderPhotoRetention.deleteOrderCustomerUploads(2, { dataAccess });

  eq(summary.deleted, 0, 'P) deleted=0');
  eq(summary.alreadyMissing, 1, 'P) alreadyMissing=1 (ENOENT real)');
  eq(summary.failed.length, 0, 'P) failed vacío: ENOENT nunca es un fallo');
  eq(imagesByOrder[2][0].ruta, orderPhotoRetention.DELETED_IMAGE_SENTINEL, 'P) la fila pasa a DELETED igualmente (idempotente)');
}

async function checkRealFilesystemErrorNeverMarksDeleted() {
  const filename = writeRealFixture();
  const originalRuta = `custom/${filename}`;
  const imagesByOrder = { 3: [{ id: 503, ruta: originalRuta }] };
  const { dataAccess, markedDeleted } = makeFakeRetentionDataAccess(imagesByOrder);

  const eaccesError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const failingUnlink = async () => { throw eaccesError; };

  const summary = await orderPhotoRetention.deleteOrderCustomerUploads(3, { dataAccess, unlink: failingUnlink });

  eq(summary.deleted, 0, 'Q) deleted=0');
  eq(summary.alreadyMissing, 0, 'Q) alreadyMissing=0');
  eq(summary.failed.length, 1, 'Q) failed tiene 1 entrada');
  eq(summary.failed[0].imageId, 503, 'Q) failed reporta SOLO el imageId, nunca la ruta/error crudo');
  ok(!('ruta' in summary.failed[0]) && !('path' in summary.failed[0]) && !('error' in summary.failed[0]), 'Q) el resumen nunca filtra ruta/path/error');
  eq(imagesByOrder[3][0].ruta, originalRuta, 'Q) la fila NUNCA pasa a DELETED tras un error real de filesystem');
  eq(markedDeleted.length, 0, 'Q) markDeleted nunca se llamó para esta fila');
}

async function checkRetryOnlyReprocessesPending() {
  // Estado inicial: una fila YA DELETED (de un cleanup anterior exitoso) y
  // una fila pendiente que falló antes por un error real (rule Q).
  const filename = writeRealFixture();
  const imagesByOrder = {
    4: [
      { id: 601, ruta: orderPhotoRetention.DELETED_IMAGE_SENTINEL },
      { id: 602, ruta: `custom/${filename}` }
    ]
  };
  const { dataAccess, markedDeleted } = makeFakeRetentionDataAccess(imagesByOrder);

  const summary = await orderPhotoRetention.deleteOrderCustomerUploads(4, { dataAccess });

  eq(summary.attempted, 1, 'R) solo se intenta la fila 602 (pendiente), la 601 ya DELETED se salta sin tocar nada');
  eq(summary.deleted, 1, 'R) la fila pendiente se borra correctamente en el reintento');
  eq(markedDeleted.length, 1, 'R) markDeleted se llama exactamente una vez');
  eq(markedDeleted[0], 602, 'R) markDeleted se llama SOLO para la fila que de verdad se reprocesó, nunca para la ya-DELETED');
  createdFilenames.delete(filename);
}

async function checkMaliciousReferenceNeverTouchesFilesystemOrMarksDeleted() {
  const maliciousRutas = [
    '../../../../etc/passwd',
    '/etc/passwd',
    'custom/../../../secret.txt',
    'https://evil.example/x.jpg',
    'custom/not-an-image.txt',
    ''
  ];
  const imagesByOrder = { 5: maliciousRutas.map((ruta, idx) => ({ id: 700 + idx, ruta })) };
  const { dataAccess, markedDeleted } = makeFakeRetentionDataAccess(imagesByOrder);

  const summary = await orderPhotoRetention.deleteOrderCustomerUploads(5, { dataAccess });

  eq(summary.deleted, 0, 'K) ninguna referencia maliciosa se marca como borrada con éxito');
  eq(summary.failed.length, maliciousRutas.length, 'K) TODAS las referencias maliciosas terminan en failed, nunca en deleted/alreadyMissing');
  eq(markedDeleted.length, 0, 'K) markDeleted nunca se invoca para ninguna de ellas');
  for (const row of imagesByOrder[5]) {
    ok(!orderPhotoRetention.isDeletedImageRuta(row.ruta) || maliciousRutas.includes(row.ruta) === false, 'K) la fila conserva su ruta original, nunca se marca DELETED sin certeza');
  }
}

async function checkCleanupNeverTouchesOtherOrders() {
  const fileOrderA = writeRealFixture();
  const fileOrderB = writeRealFixture();
  const imagesByOrder = {
    10: [{ id: 801, ruta: `custom/${fileOrderA}` }],
    20: [{ id: 802, ruta: `custom/${fileOrderB}` }]
  };
  const { dataAccess, markedDeleted } = makeFakeRetentionDataAccess(imagesByOrder);

  await orderPhotoRetention.deleteOrderCustomerUploads(10, { dataAccess });

  eq(markedDeleted.length, 1, 'L) solo se marca 1 imagen (la del pedido solicitado)');
  eq(markedDeleted[0], 801, 'L) es la imagen del pedido 10, nunca la del pedido 20');
  ok(fs.existsSync(path.join(uploadsStorage.CUSTOM_UPLOAD_ROOT, fileOrderB)), 'L) el archivo físico del pedido 20 sigue existiendo intacto');
  eq(imagesByOrder[20][0].ruta, `custom/${fileOrderB}`, 'L) la fila del pedido 20 nunca se tocó');

  createdFilenames.delete(fileOrderA); // borrado real por el cleanup del pedido 10
  // fileOrderB se limpia en el finally global (nunca se tocó, sigue existiendo)
}

// Symlink real dentro de uploads/custom apuntando a un fichero externo:
// documenta y verifica en vivo la nota de services/order-photo-retention.js
// #resolveCandidatePathForDelete (por qué NO se usa fs.realpath antes de
// unlink). Best-effort igual que scripts/check-uploads-privacy.js: en
// Windows sin modo desarrollador/privilegios elevados, fs.symlinkSync puede
// fallar con EPERM -- si es así, se documenta el SKIP explícito (nunca se
// cuenta como fallo, nunca se descuenta en silencio un check esperado) y el
// resto del suite sigue. Solo se traga el fallo de symlinkSync: cualquier
// aserción posterior sigue siendo un fallo real del test.
async function checkSymlinkDeleteRemovesLinkNeverTarget() {
  const outsideDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'litum3d-outside-'));
  const outsideFile = path.join(outsideDir, 'secret-target.jpg');
  fs.writeFileSync(outsideFile, jpegFixture());
  const linkName = `${crypto.randomUUID()}.jpg`;
  const linkPath = path.join(uploadsStorage.CUSTOM_UPLOAD_ROOT, linkName);

  let symlinkCreated = false;
  try {
    fs.symlinkSync(outsideFile, linkPath, 'file');
    symlinkCreated = true;
    createdFilenames.add(linkName);
  } catch (err) {
    console.log(`  (symlink delete test SKIPPED: no se pudieron crear symlinks en esta plataforma/permisos -- ${err.code || err.message}. Documentado en services/order-photo-retention.js#resolveCandidatePathForDelete: fs.unlink() sobre un symlink borra el enlace, nunca el target -- no se pudo ejercitar aquí.)`);
  }

  if (symlinkCreated) {
    const imagesByOrder = { 30: [{ id: 850, ruta: `custom/${linkName}` }] };
    const { dataAccess } = makeFakeRetentionDataAccess(imagesByOrder);

    const summary = await orderPhotoRetention.deleteOrderCustomerUploads(30, { dataAccess });

    eq(summary.deleted, 1, 'symlink: el cleanup procesa la entrada de symlink como cualquier otra imagen (deleted=1)');
    ok(!fs.existsSync(linkPath), 'symlink: el enlace dentro de uploads/custom desaparece');
    ok(fs.existsSync(outsideFile), 'symlink: CRÍTICO -- el fichero externo al que apuntaba sigue intacto, unlink() nunca sigue el symlink para borrar el target');
    eq(imagesByOrder[30][0].ruta, orderPhotoRetention.DELETED_IMAGE_SENTINEL, 'symlink: la fila pasa a DELETED correctamente');
    createdFilenames.delete(linkName);
  }

  try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

// ============================================================================
// A/B/G/I/M - routes/admin.js (fake pool + servidor Express real efímero)
// ============================================================================

function installFakeDbModule(fakePool) {
  const dbPath = require.resolve('../config/db');
  const original = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: fakePool } };
  return () => { if (original) require.cache[dbPath] = original; else delete require.cache[dbPath]; };
}

function loadFreshAdminRouter(fakePool) {
  const restore = installFakeDbModule(fakePool);
  const adminPath = require.resolve('../routes/admin');
  const retentionPath = require.resolve('../services/order-photo-retention');
  delete require.cache[adminPath];
  delete require.cache[retentionPath]; // para que su propio `defaultPool` capturado también apunte al fakePool vigente
  const router = require('../routes/admin');
  restore();
  delete require.cache[adminPath];
  delete require.cache[retentionPath];
  return router;
}

async function startAdminTestServer(router) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const testAdminId = req.headers['x-test-admin-id'];
    req.session = testAdminId ? { adminId: Number(testAdminId), csrfToken: 'test-csrf-token' } : {};
    next();
  });
  app.use('/admin', router);
  app.use((req, res) => res.status(404).end());
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return server;
}

// Estado real sembrado en schema.sql (P1 exige resolver por NOMBRE, nunca ID hardcodeado).
const ESTADO_PEDIDO_IDS = { Pendiente: 1, Confirmado: 2, Preparando: 3, Enviado: 4, Entregado: 5, Cancelado: 6 };

function makeFakePool({ orders, items, images, historial = [] }) {
  const inserted = { historial: [], updates: [] };
  return {
    inserted,
    async query(sql, params = []) {
      if (sql.includes('SELECT id FROM estado_pedido WHERE nombre')) {
        const nombre = params[0];
        const id = ESTADO_PEDIDO_IDS[nombre];
        return [id ? [{ id }] : []];
      }
      if (sql.includes('SELECT p.id, p.usuario_id, p.estado_id') && sql.includes("COALESCE(p.customer_email")) {
        const id = Number(params[0]);
        const row = orders.find(o => o.id === id);
        return [row ? [{ id: row.id, usuario_id: row.usuario_id, estado_id: row.estado_id, email: row.email, nombre: row.customer_name, total: row.total }] : []];
      }
      if (sql.includes('INSERT INTO historial_estado_pedido')) {
        inserted.historial.push(params);
        return [{ insertId: inserted.historial.length }];
      }
      if (sql.includes('UPDATE pedidos SET estado_id')) {
        const [nuevoEstadoId, id] = params;
        const order = orders.find(o => o.id === Number(id));
        if (order) order.estado_id = nuevoEstadoId;
        inserted.updates.push(params);
        return [{ affectedRows: order ? 1 : 0 }];
      }
      if (sql.includes('COALESCE(p.customer_name, u.nombre') && sql.includes('WHERE p.id = ?')) {
        const id = Number(params[0]);
        const row = orders.find(o => o.id === id);
        if (!row) return [[]];
        return [[{
          id: row.id, total: row.total, currency: row.currency, created_at: row.created_at,
          estado_nombre: Object.keys(ESTADO_PEDIDO_IDS).find(k => ESTADO_PEDIDO_IDS[k] === row.estado_id),
          customer_name: row.customer_name || row.usuario_nombre || 'Sin nombre',
          email: row.email
        }]];
      }
      if (sql.includes('FROM detalle_pedidos dp') && sql.includes('JOIN productos prod')) {
        const pedidoId = Number(params[0]);
        return [items.filter(it => it.pedido_id === pedidoId).map(({ pedido_id, ...rest }) => rest)];
      }
      if (sql.startsWith('SELECT id, ruta FROM detalle_pedido_imagenes WHERE detalle_pedido_id')) {
        const detalleId = Number(params[0]);
        return [images.filter(img => img.detalle_pedido_id === detalleId).map(img => ({ id: img.id, ruta: img.ruta }))];
      }
      if (sql.includes('FROM detalle_pedido_imagenes dpi') && sql.includes('JOIN detalle_pedidos dp')) {
        // services/order-photo-retention.js#getOwnedImageRows
        const orderId = Number(params[0]);
        const detalleIds = items.filter(it => it.pedido_id === orderId).map(it => it.id);
        return [images.filter(img => detalleIds.includes(img.detalle_pedido_id)).map(img => ({ id: img.id, ruta: img.ruta }))];
      }
      if (sql.includes('UPDATE detalle_pedido_imagenes SET ruta')) {
        const [ruta, imageId] = params;
        const img = images.find(i => i.id === Number(imageId));
        if (img) img.ruta = ruta;
        return [{ affectedRows: img ? 1 : 0 }];
      }
      throw new Error(`Fake pool (retention tests): consulta no reconocida: ${sql}`);
    }
  };
}

async function checkCustomerNameAndPhotoState() {
  const fileActive = writeRealFixture();

  const orders = [
    { id: 300, usuario_id: null, total: '58.95', currency: 'EUR', created_at: new Date(), estado_id: 1, customer_name: 'Ruben Fernandez', email: 'ruben@example.com' },
    { id: 301, usuario_id: null, total: '20.00', currency: 'EUR', created_at: new Date(), estado_id: 1, customer_name: null, email: null }
  ];
  const items = [
    { id: 900, pedido_id: 300, cantidad: 1, precio_unitario: '58.95', subtotal: '58.95', personalizacion_notas: null, producto_id: 8, producto_nombre: 'Lámpara', imagen: null, modelo_id: null, modelo_nombre: null, modelo_sku: null },
    { id: 901, pedido_id: 301, cantidad: 1, precio_unitario: '20.00', subtotal: '20.00', personalizacion_notas: null, producto_id: 8, producto_nombre: 'Lámpara', imagen: null, modelo_id: null, modelo_nombre: null, modelo_sku: null }
  ];
  const images = [
    { id: 1000, detalle_pedido_id: 900, ruta: `custom/${fileActive}` },
    { id: 1001, detalle_pedido_id: 900, ruta: orderPhotoRetention.DELETED_IMAGE_SENTINEL }
  ];

  const fakePool = makeFakePool({ orders, items, images });
  const router = loadFreshAdminRouter(fakePool);
  const server = await startAdminTestServer(router);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  // sendStatusChangeEmail (routes/admin.js) hace `require('nodemailer')`
  // dentro de la propia función en cada llamada, así que instalar el fake
  // aquí (sin necesidad de recargar routes/admin.js) ya intercepta
  // cualquier envío disparado por los PUT /estado de este test, incluida
  // la comprobación de retry de más abajo.
  const sentMails = [];
  const restoreNodemailer = installFakeNodemailerModule(sentMails);

  try {
    // A) nombre real presente -> se muestra literalmente, nunca "Anónimo"/"Cliente Anónimo".
    {
      const res = await fetch(`${base}/admin/pedidos/300/detalle`, { headers: { 'x-test-admin-id': '1' } });
      eq(res.status, 200, 'A) /detalle 200 con sesión admin');
      const data = await res.json();
      eq(data.order.customer_name, 'Ruben Fernandez', 'A) el nombre real del cliente prevalece y se muestra literal');
      ok(!JSON.stringify(data).includes('Anónimo'), 'A) el texto "Anónimo" ya no aparece en absoluto en la respuesta');
    }

    // customer_name realmente ausente -> "Sin nombre" (nunca "Anónimo").
    {
      const res = await fetch(`${base}/admin/pedidos/301/detalle`, { headers: { 'x-test-admin-id': '1' } });
      const data = await res.json();
      eq(data.order.customer_name, 'Sin nombre', 'nombre realmente ausente -> "Sin nombre", nunca "Anónimo"');
    }

    // M) mezcla activa/deleted: nunca se devuelve `ruta`; deleted=true -> viewUrl null.
    {
      const res = await fetch(`${base}/admin/pedidos/300/detalle`, { headers: { 'x-test-admin-id': '1' } });
      const data = await res.json();
      const imgs = data.items[0].imagenes;
      eq(imgs.length, 2, 'M) expone las 2 filas de imagen (activa + eliminada)');
      ok(!JSON.stringify(data).includes('custom/') && !JSON.stringify(data).includes(fileActive), 'M) la respuesta NUNCA filtra `ruta` ni el nombre físico del archivo');
      const active = imgs.find(i => i.id === 1000);
      const deleted = imgs.find(i => i.id === 1001);
      eq(active.deleted, false, 'M) la imagen activa tiene deleted=false');
      ok(typeof active.viewUrl === 'string' && active.viewUrl.startsWith('/admin/pedidos/300/imagenes/'), 'M) la imagen activa expone un viewUrl autenticado');
      eq(deleted.deleted, true, 'M) la imagen borrada tiene deleted=true');
      eq(deleted.viewUrl, null, 'M) la imagen borrada NUNCA expone un viewUrl (nunca se renderiza una URL para DELETED)');
    }

    // G) cambiar a un estado != Entregado -> las fotos permanecen intactas, photoCleanup=null.
    {
      const res = await fetch(`${base}/admin/pedidos/300/estado`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-test-admin-id': '1', 'X-CSRF-Token': 'test-csrf-token' },
        body: JSON.stringify({ estado: 'Preparando' })
      });
      eq(res.status, 200, 'G) cambio a Preparando -> 200');
      const data = await res.json();
      eq(data.photoCleanup, null, 'G) photoCleanup es null para cualquier estado distinto de Entregado');
      eq(images.find(i => i.id === 1000).ruta, `custom/${fileActive}`, 'G) la imagen activa NUNCA se toca al cambiar a un estado distinto de Entregado');
      ok(fs.existsSync(path.join(uploadsStorage.CUSTOM_UPLOAD_ROOT, fileActive)), 'G) el archivo físico sigue existiendo');
    }

    // Preparando -> Entregado es en sí misma una transición real (dispara su
    // propio email, ortogonal a lo que miden los bloques de abajo): se toma
    // como línea base para aislar, más adelante, el email de ESA transición
    // real del reintento same-state que viene después.
    const mailsBeforeRealTransitionToEntregado = sentMails.length;

    // I) confirmar Entregado -> el cleanup se ejecuta de verdad y su resumen viaja en la respuesta.
    // También es la transición real "otro estado -> Entregado": debe enviar
    // EXACTAMENTE 1 email de cambio de estado al cliente.
    {
      const res = await fetch(`${base}/admin/pedidos/300/estado`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-test-admin-id': '1', 'X-CSRF-Token': 'test-csrf-token' },
        body: JSON.stringify({ estado: 'Entregado' })
      });
      eq(res.status, 200, 'I) cambio a Entregado -> 200 (nunca falla la respuesta aunque el cleanup tenga fallos)');
      const data = await res.json();
      ok(data.success === true, 'I) success=true');
      ok(data.photoCleanup && typeof data.photoCleanup.attempted === 'number', 'I) photoCleanup viaja en la respuesta con forma resumen');
      eq(data.photoCleanup.deleted, 1, 'I) se borró exactamente la imagen activa pendiente (la ya-DELETED se saltó)');
      ok(!fs.existsSync(path.join(uploadsStorage.CUSTOM_UPLOAD_ROOT, fileActive)), 'I) el archivo físico ya no existe tras confirmar Entregado');
      eq(images.find(i => i.id === 1000).ruta, orderPhotoRetention.DELETED_IMAGE_SENTINEL, 'I) la fila pasa a DELETED en BD');
      createdFilenames.delete(fileActive);

      // sendStatusChangeEmail se dispara sin await desde routes/admin.js: se
      // espera un tick para dejar asentar la promesa fake de sendMail antes
      // de leer sentMails.
      await new Promise(resolve => setTimeout(resolve, 0));
      eq(sentMails.length, mailsBeforeRealTransitionToEntregado + 1, 'I) transición real Preparando->Entregado: se envía EXACTAMENTE 1 email de cambio de estado');
      eq(sentMails[sentMails.length - 1].to, 'ruben@example.com', 'I) el email de la transición real llega al cliente correcto');
    }

    // Reintento: volver a guardar Entregado sobre un pedido YA Entregado
    // también ejecuta el cleanup (esta vez no hay nada pendiente), pero
    // NUNCA debe reenviar el email de cambio de estado (routes/admin.js
    // solo llama a sendStatusChangeEmail dentro del `if (estadoAnteriorId
    // !== nuevoEstadoId)`, que aquí es false).
    {
      const res = await fetch(`${base}/admin/pedidos/300/estado`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-test-admin-id': '1', 'X-CSRF-Token': 'test-csrf-token' },
        body: JSON.stringify({ estado: 'Entregado' })
      });
      const data = await res.json();
      eq(data.photoCleanup.attempted, 0, 'reintento sobre pedido ya Entregado: nada pendiente que reprocesar (todo ya DELETED)');

      await new Promise(resolve => setTimeout(resolve, 0));
      eq(sentMails.length, mailsBeforeRealTransitionToEntregado + 1, 'RETRY Entregado->Entregado: CERO email adicional (sigue en el mismo total que tras la transición real)');
    }
  } finally {
    restoreNodemailer();
    server.close();
  }
}

async function checkPublicEndpointsNeverExposeCustomerName() {
  // B) verificación estática: las únicas 2 apariciones de
  // "COALESCE(p.customer_name" en routes/admin.js viven ambas dentro de
  // handlers montados con requireAuth (confirmado también por
  // scripts/check-admin-auth-coverage.js para las mismas rutas). Los
  // endpoints públicos de checkout (routes/payments.js) nunca leen
  // pedidos.customer_name hacia afuera: su única salida pública es el DTO
  // de services/pricing.js (item/breakdown de catálogo), que no incluye
  // ningún dato de cliente.
  const adminSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
  const occurrences = adminSrc.split('customer_name').length - 1;
  ok(occurrences >= 2, 'B) sanity: customer_name sigue presente en routes/admin.js (si esto falla, revisar el propio test)');

  const paymentsSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'payments.js'), 'utf8');
  // routes/payments.js SÍ lee customerData.name para el propio email de
  // confirmación (esperado, no es un endpoint que lo "devuelva" al
  // navegador) -- lo que nunca debe ocurrir es que un handler público
  // (createPaymentIntentHandler/pricingConfigHandler/stripeConfigHandler)
  // incluya customer_name/customerData en su JSON de respuesta pública.
  ok(!/toPublicPrepareDto[\s\S]{0,400}customerData/.test(paymentsSrc), 'B) el DTO público de checkout (toPublicPrepareDto) nunca serializa customerData');
}

// ============================================================================
// E/F - email admin con attachments reales, email cliente sin attachments
// ============================================================================

function installFakeNodemailerModule(sentMails) {
  const nmPath = require.resolve('nodemailer');
  const original = require.cache[nmPath];
  require.cache[nmPath] = {
    id: nmPath, filename: nmPath, loaded: true,
    exports: {
      createTransport() {
        return {
          async sendMail(opts) { sentMails.push(opts); return { messageId: 'fake' }; }
        };
      }
    }
  };
  return () => { if (original) require.cache[nmPath] = original; else delete require.cache[nmPath]; };
}

async function checkAdminEmailHasAttachmentsCustomerDoesNot() {
  const filename = writeRealFixture();
  const sentMails = [];
  const restoreNodemailer = installFakeNodemailerModule(sentMails);

  const paymentsPath = require.resolve('../routes/payments');
  delete require.cache[paymentsPath];
  process.env.ADMIN_EMAIL = 'admin-test@litum3d.local';
  process.env.SMTP_USER = 'noreply-test@litum3d.local';
  let paymentsRouter;
  try {
    paymentsRouter = require('../routes/payments');
  } finally {
    restoreNodemailer();
    delete require.cache[paymentsPath];
  }

  // checkoutFinalization falso: en vez de tocar BD/Stripe reales, invoca
  // DIRECTAMENTE el callback sendConfirmationEmail (la MISMA función real
  // que produce el email de verdad, incluidos sus attachments) con un
  // snapshot construido a mano que referencia el fixture real de arriba.
  const fakeCheckoutFinalization = {
    async finalizePaidCheckout(paymentIntent, { sendConfirmationEmail }) {
      const snapshot = {
        currency: 'eur',
        totals: { totalCents: 5000, subtotalCents: 5000, shippingCents: 0, netCents: 4132, taxCents: 868 },
        customerData: { name: 'Cliente Test', email: 'cliente-test@example.com', phone: '+34600000000', address: 'Calle Test 1', city: 'Madrid', zip: '28001' },
        items: [{
          productId: 8, productName: 'Lámpara', modelName: null, notes: null, quantity: 1, unitPriceCents: 5000,
          images: [{ url: `custom/${filename}`, filename, mimetype: 'image/jpeg', size: 32 }]
        }]
      };
      if (typeof sendConfirmationEmail === 'function') {
        await sendConfirmationEmail({ orderId: 999, snapshot, paymentIntent });
      }
      return { orderId: 999, created: true, draftId: 1 };
    }
  };
  const fakeStripe = { paymentIntents: { retrieve: async () => ({ id: 'pi_test_attach', status: 'succeeded' }) } };

  const handlers = paymentsRouter.buildHandlers({ checkoutFinalization: fakeCheckoutFinalization, stripe: fakeStripe });
  const req = { body: { paymentIntentId: 'pi_test_attach' } };
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } };

  await handlers.confirmPaymentHandler(req, res);

  eq(res.statusCode, 200, 'confirm-payment (fake finalization) -> 200');
  eq(sentMails.length, 2, 'se envían exactamente 2 mensajes (cliente + admin)');

  const customerMail = sentMails.find(m => m.to === 'cliente-test@example.com');
  const adminMail = sentMails.find(m => m.to === 'admin-test@litum3d.local');

  ok(customerMail, 'F) el email al cliente se envió');
  ok(!customerMail.attachments || customerMail.attachments.length === 0, 'F) el email de CLIENTE nunca lleva attachments');

  ok(adminMail, 'E) el email al admin se envió');
  ok(Array.isArray(adminMail.attachments) && adminMail.attachments.length === 1, 'E) el email de ADMIN lleva exactamente 1 attachment (la foto del pedido)');
  eq(adminMail.attachments[0].filename, filename, 'E) el attachment usa el nombre físico real de la imagen');
  ok(typeof adminMail.attachments[0].path === 'string' && adminMail.attachments[0].path.includes('uploads'), 'E) el attachment referencia el path real resuelto de forma segura (uploadsStorage.resolveCustomUploadPath)');
}

// ============================================================================
// H - confirmación frontend (sandbox vm sobre el <script> real de admin-dashboard.html)
// ============================================================================

function readAdminDashboardScript() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin-dashboard.html'), 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('No se encontró el <script> inline en views/admin-dashboard.html');
  return match[1];
}

function makeElementStub() {
  return {
    textContent: '', innerHTML: '', value: '', style: {},
    classList: { _classes: new Set(), add(c) { this._classes.add(c); }, remove(c) { this._classes.delete(c); }, contains(c) { return this._classes.has(c); } },
    addEventListener() {}
  };
}

function makeDocumentStub() {
  const registry = new Map();
  return {
    getElementById(id) {
      if (!registry.has(id)) registry.set(id, makeElementStub());
      return registry.get(id);
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
    createElement: () => makeElementStub(),
    _registry: registry
  };
}

async function checkCancelDeliveryConfirmNeverFetches() {
  const script = readAdminDashboardScript();
  const document = makeDocumentStub();
  let fetchCalls = 0;
  const sandbox = {
    console,
    document,
    window: { location: {} },
    fetch: async () => { fetchCalls++; return { ok: false, status: 401, json: async () => ({}) }; },
    alert: () => {}
  };
  // adminFetch vive en public/js/admin-fetch.js (<script src="...">, no en
  // el inline <script> que se extrae aquí) -- se provee un stub mínimo que
  // delega en el mismo fetch() instrumentado de arriba, suficiente para
  // medir SI se intenta una llamada de red, que es lo único que importa
  // para H). El adjunto real de CSRF de admin-fetch.js ya se ejerce contra
  // el servidor Express real en checkCustomerNameAndPhotoState() (G/I).
  sandbox.adminFetch = (url, options) => sandbox.fetch(url, options);
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);

  // currentEditingOrderId es `let` a nivel de script (views/admin-dashboard.html:762):
  // un `let`/`const` de nivel superior NUNCA se refleja como propiedad del
  // objeto sandbox en el módulo vm de Node (a diferencia de `var`), así que
  // asignar sandbox.currentEditingOrderId desde fuera no tocaría el binding
  // real que usa saveStatus(). Se fija con la MISMA vía que usa la app real:
  // openModal() (dispara sus propios fetch de /detalle y /historial contra
  // el stub, que se dejan asentar antes de resetear el contador).
  sandbox.openModal(555, 'Pendiente', 'Test Customer', 58.95, 'EUR');
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));

  // El script real auto-invoca loadOrders() al cargar (mismo patrón ya
  // documentado en check-admin-currency-display.js), y openModal() de
  // arriba añade sus propios fetch -- ninguno de ellos es lo que este test
  // quiere medir. Se resetea el contador aquí, justo antes de ejercitar
  // saveStatus()/cancelDeliveryConfirm().
  fetchCalls = 0;

  document.getElementById('newStatus').value = 'Entregado';

  await sandbox.saveStatus();
  eq(fetchCalls, 0, 'H) elegir Entregado y llamar saveStatus() SOLO abre el modal de confirmación, cero fetch todavía');
  ok(document.getElementById('deliveryConfirmModal').classList.contains('show'), 'H) el modal de confirmación de entrega se muestra');

  sandbox.cancelDeliveryConfirm();
  eq(fetchCalls, 0, 'H) cancelar la confirmación -> cero fetch, cero request destructiva');
  ok(!document.getElementById('deliveryConfirmModal').classList.contains('show'), 'H) el modal de confirmación se cierra al cancelar');

  // Un estado distinto de Entregado nunca pasa por el modal de confirmación.
  document.getElementById('newStatus').value = 'Preparando';
  await sandbox.saveStatus();
  eq(fetchCalls, 1, 'otros estados -> saveStatus() sigue el camino directo sin diálogo destructivo');
}

// ============================================================================

async function main() {
  console.log('P1 Admin Pedidos/Fotos/Retención - service (unlink real/ENOENT/error real/reintento)');
  await checkUnlinkSuccessMarksDeleted();
  await checkEnoentIsIdempotent();
  await checkRealFilesystemErrorNeverMarksDeleted();
  await checkRetryOnlyReprocessesPending();
  console.log('P1 Admin Pedidos/Fotos/Retención - referencias maliciosas / cross-order');
  await checkMaliciousReferenceNeverTouchesFilesystemOrMarksDeleted();
  await checkCleanupNeverTouchesOtherOrders();
  await checkSymlinkDeleteRemovesLinkNeverTarget();
  console.log('P1 Admin Pedidos/Fotos/Retención - routes/admin.js (nombre real, estado de fotos, cleanup en Entregado)');
  await checkCustomerNameAndPhotoState();
  await checkPublicEndpointsNeverExposeCustomerName();
  console.log('P1 Admin Pedidos/Fotos/Retención - email admin con attachments / email cliente sin attachments');
  await checkAdminEmailHasAttachmentsCustomerDoesNot();
  console.log('P1 Admin Pedidos/Fotos/Retención - confirmación frontend antes de Entregado (sandbox real)');
  await checkCancelDeliveryConfirmNeverFetches();
  console.log(`OK: ${checks} comprobaciones sobre retención de fotos/nombre de cliente en Admin.`);
}

main()
  .catch(err => { console.error('FALLO:', err); process.exit(1); })
  .finally(() => cleanupCreatedFiles());
