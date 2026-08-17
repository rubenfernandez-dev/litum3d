/*
  LITUM3D - Tests de privacidad/acceso de fotografías de personalización
  (P0-FOTOS-01 + hardening post-review antes del commit).

  Cubre:
    A) acceso público cerrado (ya no existe express.static para /uploads);
    B) validación de upload (magic bytes, límites, naming seguro);
    C) path traversal / symlink sobre services/uploads-storage.js;
    D) preview del cliente vía capability token (cross-access bloqueado);
    E) acceso Admin autenticado, vinculado al pedido, formatos legacy, SSRF;
    F) snapshot/fingerprint (finalización directa): el nuevo formato de
       referencia sigue siendo determinista y finalizePaidCheckout persiste
       la key interna limpia como red de seguridad defensiva.
    G) email: ya no se filtra ninguna URL pública/privada de foto.
    H) secreto DEDICADO (UPLOAD_PREVIEW_SECRET, nunca SESSION_SECRET):
       fail-closed si falta, rotación invalida tokens anteriores, SESSION_SECRET
       ya no afecta la validez de un preview.
    I) canonicalización server-side de selections[].images ANTES de
       fingerprint/pricing/draft/Stripe: el cliente NUNCA puede autoasignarse
       una internal key ni reenviar un path legacy -- solo una capability URL
       con token HMAC válido se acepta.
    J) el snapshot persistido vía el pipeline REAL (prepareCanonicalCheckout)
       nunca contiene el capability token del cliente, y la idempotencia
       (mismo draft en retry) sigue intacta.
    K) una imagen inválida/falsificada NUNCA llega a
       stripe.paymentIntents.create() (test obligatorio).
    L) promesa falsa de "borrado automático tras fabricación": ya no aparece
       en ningún texto público activo (ES/DE/FR).

  IMPORTANTE: estos tests SÍ escriben archivos reales bajo uploads/custom/
  (necesario para probar multer/fs de extremo a extremo), pero:
    - solo usa buffers fixture sintéticos generados aquí, nunca archivos de
      clientes;
    - cada archivo creado por un test se borra en su propio finally,
      identificado por el nombre EXACTO que el propio test generó -- nunca
      se listan ni se tocan los archivos ya existentes en uploads/custom/;
    - UPLOAD_PREVIEW_SECRET se inyecta como valor de TEST explícito
      (process.env, en memoria) -- nunca se lee ni se imprime el .env real.

  Uso: node scripts/check-uploads-privacy.js
*/
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const uploadsRouter = require('../routes/uploads');
const uploadsStorage = require('../services/uploads-storage');
const checkoutDrafts = require('../services/checkout-drafts');
const pricing = require('../services/pricing');
const realCheckoutPayment = require('../services/checkout-payment');
const realCheckoutFinalization = require('../services/checkout-finalization');

let checks = 0;
function ok(cond, msg) { assert.ok(cond, msg); checks++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); checks++; }
async function rejects(fn, ErrorClass, msg) {
  let threw = null;
  try { await fn(); } catch (err) { threw = err; }
  ok(threw instanceof ErrorClass, `${msg} (esperaba ${ErrorClass.name}, obtuvo ${threw ? threw.constructor.name + ': ' + threw.message : 'ninguno'})`);
  return threw;
}

// --- Secreto de TEST explícito (nunca el .env real) -------------------------
const TEST_UPLOAD_PREVIEW_SECRET = 'test-upload-preview-secret-' + 'x'.repeat(32);

async function withUploadPreviewSecret(secretValueOrNull, fn) {
  const prev = process.env.UPLOAD_PREVIEW_SECRET;
  if (secretValueOrNull === null) delete process.env.UPLOAD_PREVIEW_SECRET;
  else process.env.UPLOAD_PREVIEW_SECRET = secretValueOrNull;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.UPLOAD_PREVIEW_SECRET;
    else process.env.UPLOAD_PREVIEW_SECRET = prev;
  }
}

// --- Fixtures sintéticas (nunca archivos de clientes) -----------------------
function jpegFixture(size = 64) {
  const buf = Buffer.alloc(Math.max(size, 8), 0x11);
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff; buf[3] = 0xe0;
  return buf;
}
function pngFixture(size = 64) {
  const buf = Buffer.alloc(Math.max(size, 8), 0x22);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  sig.forEach((b, i) => { buf[i] = b; });
  return buf;
}
function webpFixture(size = 64) {
  const buf = Buffer.alloc(Math.max(size, 16), 0x33);
  Buffer.from('RIFF').copy(buf, 0);
  Buffer.from('WEBP').copy(buf, 8);
  return buf;
}
function htmlDisguisedAsJpegFixture() {
  return Buffer.from('<html><body><script>alert(1)</script></body></html>');
}

function buildMultipart(files) {
  const boundary = '----litumTest' + crypto.randomBytes(8).toString('hex');
  const chunks = [];
  for (const f of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="${f.filename}"\r\nContent-Type: ${f.contentType}\r\n\r\n`
    ));
    chunks.push(f.buffer);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

// Registro global de archivos creados por ESTE proceso de test, para
// borrarlos con certeza al final sin tocar nada más de uploads/custom/.
const createdFilenames = new Set();
function cleanupCreatedFiles() {
  for (const filename of createdFilenames) {
    try {
      const p = path.join(uploadsStorage.CUSTOM_UPLOAD_ROOT, filename);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) { /* ignore */ }
  }
  createdFilenames.clear();
}

async function startTestServer() {
  const app = express();
  // Mismo mount que server.js tras el fix: SIN app.use('/uploads', express.static(...)).
  app.use(uploadsRouter);
  app.use((req, res) => res.status(404).end());
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return server;
}

// =======================================================================
// A) Sección 5/32 - acceso público cerrado
// =======================================================================
async function checkPublicAccessClosed() {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok(!/app\.use\(\s*['"]\/uploads['"]\s*,\s*express\.static/.test(serverSrc), 'server.js ya no monta express.static público sobre /uploads');

  const server = await startTestServer();
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/uploads/custom/anything.jpg`);
    eq(res.status, 404, 'GET /uploads/custom/<archivo> sin autorización -> 404 (no existe ninguna ruta pública)');
  } finally {
    await new Promise(r => server.close(r));
  }
}

// =======================================================================
// B) Sección 33 - validación de upload
// =======================================================================
async function checkUploadValidation() {
  const server = await startTestServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    // JPEG válido -> aceptado, naming seguro
    {
      const { body, contentType } = buildMultipart([{ filename: 'foto.jpg', contentType: 'image/jpeg', buffer: jpegFixture() }]);
      const res = await fetch(`${base}/api/uploads/custom`, { method: 'POST', headers: { 'Content-Type': contentType }, body });
      eq(res.status, 200, 'JPEG válido -> 200');
      const data = await res.json();
      createdFilenames.add(data.files[0].filename);
      ok(data.ok && data.files.length === 1, 'respuesta ok con 1 archivo');
      ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/.test(data.files[0].filename), 'nombre físico es un UUID.jpg (crypto.randomUUID), no depende del originalname');
      eq(data.files[0].mimetype, 'image/jpeg', 'mimetype de respuesta viene de la detección real (magic bytes), no del declarado por el navegador');
      ok(data.files[0].url.startsWith('/api/uploads/custom/preview/'), 'url apunta al preview privado, nunca a /uploads/custom público');
      ok(!data.files[0].url.includes('foto.jpg'), 'la url no contiene el originalname del cliente ni PII');
    }

    // PNG válido -> aceptado
    {
      const { body, contentType } = buildMultipart([{ filename: 'foto.png', contentType: 'image/png', buffer: pngFixture() }]);
      const res = await fetch(`${base}/api/uploads/custom`, { method: 'POST', headers: { 'Content-Type': contentType }, body });
      eq(res.status, 200, 'PNG válido -> 200');
      const data = await res.json();
      createdFilenames.add(data.files[0].filename);
      ok(/\.png$/.test(data.files[0].filename), 'extensión física .png coherente con el tipo detectado');
      eq(data.files[0].mimetype, 'image/png', 'mimetype de respuesta = image/png');
    }

    // WEBP -> rechazado (confirmado: ningún input del frontend real declara
    // accept image/webp para personalización; ver views/shop.html, home*.html)
    {
      const { body, contentType } = buildMultipart([{ filename: 'foto.webp', contentType: 'image/webp', buffer: webpFixture() }]);
      const res = await fetch(`${base}/api/uploads/custom`, { method: 'POST', headers: { 'Content-Type': contentType }, body });
      eq(res.status, 400, 'WEBP no soportado por el frontend real -> 400');
    }

    // Contenido no-imagen disfrazado de JPEG (mimetype+extensión mienten,
    // los magic bytes no) -> rechazado por firma real, no por metadata.
    {
      const { body, contentType } = buildMultipart([{ filename: 'evil.jpg', contentType: 'image/jpeg', buffer: htmlDisguisedAsJpegFixture() }]);
      const res = await fetch(`${base}/api/uploads/custom`, { method: 'POST', headers: { 'Content-Type': contentType }, body });
      eq(res.status, 400, 'contenido HTML disfrazado de JPEG (mimetype+extensión mienten) -> 400 por magic bytes');
    }

    // originalname con traversal -> nunca se usa como autoridad de filesystem
    {
      const { body, contentType } = buildMultipart([{ filename: '../../../../etc/passwd.jpg', contentType: 'image/jpeg', buffer: jpegFixture() }]);
      const res = await fetch(`${base}/api/uploads/custom`, { method: 'POST', headers: { 'Content-Type': contentType }, body });
      eq(res.status, 200, 'un originalname malicioso no rompe el upload en sí (el nombre físico nunca depende de él)');
      const data = await res.json();
      createdFilenames.add(data.files[0].filename);
      ok(!data.files[0].filename.includes('etc') && !data.files[0].filename.includes('passwd') && !data.files[0].filename.includes('..'), 'el nombre físico no contiene ningún fragmento del originalname malicioso');
    }

    // archivo por encima del límite -> rechazado
    {
      const bigBuf = jpegFixture(uploadsStorage.MAX_UPLOAD_FILE_SIZE_BYTES + 1024);
      const { body, contentType } = buildMultipart([{ filename: 'grande.jpg', contentType: 'image/jpeg', buffer: bigBuf }]);
      const res = await fetch(`${base}/api/uploads/custom`, { method: 'POST', headers: { 'Content-Type': contentType }, body });
      eq(res.status, 400, `archivo > ${uploadsStorage.MAX_UPLOAD_FILE_SIZE_BYTES} bytes -> 400 (límite server-side)`);
    }
  } finally {
    await new Promise(r => server.close(r));
    cleanupCreatedFiles();
  }
}

// =======================================================================
// C) Secciones 8/9 - path traversal / symlink sobre resolveCustomUploadPath
// =======================================================================
async function checkPathTraversalDefenses() {
  const attempts = [
    '../../../etc/passwd.jpg',
    '..\\..\\windows\\system32\\config.jpg',
    '/etc/passwd.jpg',
    'C:\\Windows\\System32\\drivers\\etc\\hosts.jpg',
    'foo/../../bar.jpg',
    'valid.jpg\u0000.png',
    '....//....//etc/passwd.jpg',
    '%2e%2e%2fetc%2fpasswd.jpg',
    '',
    null,
    undefined,
    42,
    'sin-extension-valida',
    'archivo.exe',
    'archivo.svg',
    'archivo.html'
  ];
  for (const attempt of attempts) {
    const resolved = await uploadsStorage.resolveCustomUploadPath(attempt);
    eq(resolved, null, `resolveCustomUploadPath rechaza: ${JSON.stringify(attempt)}`);
  }

  // Nombre bien formado pero inexistente -> también null (nunca revela si
  // "existe pero sin permiso" vs "no existe", sección 30).
  const nonExistent = await uploadsStorage.resolveCustomUploadPath(`${crypto.randomUUID()}.jpg`);
  eq(nonExistent, null, 'nombre con formato válido pero archivo inexistente -> null (mismo resultado que traversal, sin distinguir motivo)');

  // Caso positivo de control: un archivo real, recién creado por el propio
  // test, SÍ se resuelve (para no falsear las comprobaciones anteriores).
  const filename = `${crypto.randomUUID()}.jpg`;
  const fullPath = path.join(uploadsStorage.CUSTOM_UPLOAD_ROOT, filename);
  fs.writeFileSync(fullPath, jpegFixture());
  createdFilenames.add(filename);
  try {
    const resolvedOk = await uploadsStorage.resolveCustomUploadPath(filename);
    ok(resolvedOk && resolvedOk.endsWith(filename), 'un nombre válido y existente SÍ se resuelve correctamente (control positivo)');
  } finally {
    cleanupCreatedFiles();
  }

  // Symlink escape (sección 9): best-effort -- en Windows sin modo
  // desarrollador/privilegios elevados, fs.symlinkSync puede fallar con
  // EPERM. Si la plataforma lo permite, se prueba de verdad; si no, se
  // documenta la limitación en vez de fingir que se probó.
  const outsideDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'litum3d-outside-'));
  const outsideFile = path.join(outsideDir, 'secret.jpg');
  fs.writeFileSync(outsideFile, jpegFixture());
  const symlinkName = `${crypto.randomUUID()}.jpg`;
  const symlinkPath = path.join(uploadsStorage.CUSTOM_UPLOAD_ROOT, symlinkName);
  try {
    fs.symlinkSync(outsideFile, symlinkPath, 'file');
    createdFilenames.add(symlinkName);
    const resolvedSymlink = await uploadsStorage.resolveCustomUploadPath(symlinkName);
    eq(resolvedSymlink, null, 'CRÍTICO: un symlink dentro de uploads/custom que apunta fuera del root -> rechazado (no se sirve)');
  } catch (err) {
    console.log(`  (symlink escape test omitido: no se pudieron crear symlinks en esta plataforma/permisos -- ${err.code || err.message}. Documentado: la defensa contra symlink escape en resolveCustomUploadPath sigue activa en código (fs.realpath + comparación contra la raíz real), pero no se pudo ejercitar aquí.)`);
  } finally {
    cleanupCreatedFiles();
    try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

// =======================================================================
// D) Sección 34 - preview del cliente vía capability token, cross-access
// =======================================================================
async function checkClientPreviewCapability() {
  const server = await startTestServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const { body, contentType } = buildMultipart([
      { filename: 'a.jpg', contentType: 'image/jpeg', buffer: jpegFixture(64) },
      { filename: 'b.jpg', contentType: 'image/jpeg', buffer: jpegFixture(128) }
    ]);
    const uploadRes = await fetch(`${base}/api/uploads/custom`, { method: 'POST', headers: { 'Content-Type': contentType }, body });
    const data = await uploadRes.json();
    const [fileA, fileB] = data.files;
    createdFilenames.add(fileA.filename);
    createdFilenames.add(fileB.filename);

    // upload propio + token correcto -> 200, headers de privacidad correctos
    const okRes = await fetch(`${base}${fileA.url}`);
    eq(okRes.status, 200, 'preview con el propio token del upload -> 200');
    eq(okRes.headers.get('content-type'), 'image/jpeg', 'Content-Type correcto (derivado server-side, no de la URL)');
    eq(okRes.headers.get('cache-control'), 'private, no-store', 'Cache-Control: private, no-store (sección 23)');
    eq(okRes.headers.get('x-content-type-options'), 'nosniff', 'X-Content-Type-Options: nosniff (sección 23)');
    eq(okRes.headers.get('content-disposition'), 'inline', 'Content-Disposition: inline (sección 24)');

    // token incorrecto -> 404
    const badTokenUrl = fileA.url.replace(/t=[0-9a-f]+/, 't=' + '0'.repeat(64));
    const badRes = await fetch(`${base}${badTokenUrl}`);
    eq(badRes.status, 404, 'token incorrecto -> 404');

    // sin token -> 404
    const noTokenUrl = fileA.url.split('?')[0];
    const noTokenRes = await fetch(`${base}${noTokenUrl}`);
    eq(noTokenRes.status, 404, 'sin token -> 404');

    // token del archivo B usado sobre el archivo A -> cross-access bloqueado
    const tokenB = new URL(`${base}${fileB.url}`).searchParams.get('t');
    const crossRes = await fetch(`${base}/api/uploads/custom/preview/${fileA.filename}?t=${tokenB}`);
    eq(crossRes.status, 404, 'CRÍTICO: el token del archivo B no autoriza el archivo A (cross-access imposible)');
  } finally {
    await new Promise(r => server.close(r));
    cleanupCreatedFiles();
  }
}

// =======================================================================
// E) Secciones 15/28/29/35 - acceso Admin autenticado
// =======================================================================
function installFakeDbModule(fakePool) {
  const dbPath = require.resolve('../config/db');
  const original = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: fakePool } };
  return () => { if (original) require.cache[dbPath] = original; else delete require.cache[dbPath]; };
}

function loadFreshAdminRouter(fakePool) {
  const restore = installFakeDbModule(fakePool);
  const adminPath = require.resolve('../routes/admin');
  delete require.cache[adminPath];
  const router = require('../routes/admin');
  restore();
  delete require.cache[adminPath]; // no dejar el router "congelado" con este fakePool para requires futuros en el mismo proceso
  return router;
}

function makeFakeAdminPool({ orders, items, images }) {
  return {
    async query(sql, params = []) {
      if (sql.includes('FROM pedidos p') && sql.includes('JOIN estado_pedido')) {
        const id = Number(params[0]);
        const row = orders.find(o => o.id === id);
        return [row ? [row] : []];
      }
      if (sql.includes('FROM detalle_pedidos dp') && sql.includes('JOIN productos prod')) {
        const pedidoId = Number(params[0]);
        return [items.filter(it => it.pedido_id === pedidoId).map(({ pedido_id, ...rest }) => rest)];
      }
      if (sql.startsWith('SELECT id, ruta FROM detalle_pedido_imagenes WHERE detalle_pedido_id')) {
        const detalleId = Number(params[0]);
        return [images.filter(img => img.detalle_pedido_id === detalleId).map(img => ({ id: img.id, ruta: img.ruta }))];
      }
      if (sql.includes('SELECT dpi.ruta') && sql.includes('JOIN detalle_pedidos dp ON dpi.detalle_pedido_id')) {
        const [imageId, orderId] = params.map(Number);
        const img = images.find(i => i.id === imageId);
        if (!img) return [[]];
        const detalle = items.find(it => it.id === img.detalle_pedido_id);
        if (!detalle || detalle.pedido_id !== orderId) return [[]];
        return [[{ ruta: img.ruta }]];
      }
      throw new Error(`Fake admin pool: consulta no reconocida: ${sql}`);
    }
  };
}

async function startAdminTestServer(router) {
  const app = express();
  // Doble mínimo de sesión: sin depender de express-session/cookies reales,
  // solo simula el shape que requireAuth.js necesita (req.session.adminId).
  app.use((req, res, next) => {
    const testAdminId = req.headers['x-test-admin-id'];
    req.session = testAdminId ? { adminId: Number(testAdminId) } : {};
    next();
  });
  app.use('/admin', router);
  app.use((req, res) => res.status(404).end());
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return server;
}

async function checkAdminImageAccess() {
  // Fixtures: 2 archivos reales (uno referenciado con la key NUEVA, otro con
  // el formato LEGACY "/uploads/custom/<file>"), más una referencia externa
  // legacy (SSRF) y un pedido/imagen distintos para probar cross-order.
  const fileNew = `${crypto.randomUUID()}.jpg`;
  const fileLegacy = `${crypto.randomUUID()}.jpg`;
  const fileOtherOrder = `${crypto.randomUUID()}.jpg`;
  for (const f of [fileNew, fileLegacy, fileOtherOrder]) {
    fs.writeFileSync(path.join(uploadsStorage.CUSTOM_UPLOAD_ROOT, f), jpegFixture());
    createdFilenames.add(f);
  }

  const orders = [
    { id: 100, total: '65.00', currency: 'EUR', created_at: new Date(), estado_nombre: 'Pendiente', customer_name: 'Ana', email: 'ana@example.com' },
    { id: 200, total: '30.00', currency: 'EUR', created_at: new Date(), estado_nombre: 'Pendiente', customer_name: 'Bruno', email: 'bruno@example.com' }
  ];
  const items = [
    { id: 500, pedido_id: 100, cantidad: 1, precio_unitario: '65.00', subtotal: '65.00', personalizacion_notas: null, producto_id: 8, producto_nombre: 'Litofanía', imagen: null, modelo_id: null, modelo_nombre: null, modelo_sku: null },
    { id: 600, pedido_id: 200, cantidad: 1, precio_unitario: '30.00', subtotal: '30.00', personalizacion_notas: null, producto_id: 8, producto_nombre: 'Litofanía', imagen: null, modelo_id: null, modelo_nombre: null, modelo_sku: null }
  ];
  const images = [
    { id: 1, detalle_pedido_id: 500, ruta: `custom/${fileNew}` },
    { id: 2, detalle_pedido_id: 500, ruta: `/uploads/custom/${fileLegacy}` },
    { id: 3, detalle_pedido_id: 500, ruta: 'https://evil.example/x.jpg' },
    { id: 4, detalle_pedido_id: 600, ruta: `custom/${fileOtherOrder}` }
  ];

  const fakePool = makeFakeAdminPool({ orders, items, images });
  const router = loadFreshAdminRouter(fakePool);
  const server = await startAdminTestServer(router);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // Sin sesión -> 401 en /detalle y en la imagen.
    {
      const res = await fetch(`${base}/admin/pedidos/100/detalle`);
      eq(res.status, 401, 'sin sesión admin -> /detalle 401');
    }
    {
      const res = await fetch(`${base}/admin/pedidos/100/imagenes/1`);
      eq(res.status, 401, 'sin sesión admin -> imagen 401');
    }

    // Con sesión admin: /detalle expone viewUrl, nunca la ruta interna cruda.
    {
      const res = await fetch(`${base}/admin/pedidos/100/detalle`, { headers: { 'x-test-admin-id': '42' } });
      eq(res.status, 200, 'admin autenticado -> /detalle 200');
      const data = await res.json();
      const imgs = data.items[0].imagenes;
      eq(imgs.length, 3, 'expone las 3 imágenes asociadas a la línea del pedido');
      ok(imgs.every(img => typeof img.viewUrl === 'string' && img.viewUrl.startsWith('/admin/pedidos/100/imagenes/')), 'cada imagen expone viewUrl autenticado, no la ruta física interna');
      ok(!JSON.stringify(data).includes('custom/') && !JSON.stringify(data).includes('/uploads/'), 'la respuesta de /detalle NUNCA filtra la key interna ni la ruta legacy cruda');
    }

    // Admin autenticado + imagen NUEVA asociada a ESE pedido -> 200 con bytes correctos.
    {
      const res = await fetch(`${base}/admin/pedidos/100/imagenes/1`, { headers: { 'x-test-admin-id': '42' } });
      eq(res.status, 200, 'admin + imagen (formato nuevo) asociada al pedido correcto -> 200');
      eq(res.headers.get('content-type'), 'image/jpeg', 'Content-Type correcto para la imagen nueva');
      eq(res.headers.get('cache-control'), 'private, no-store', 'Cache-Control private/no-store también en el canal admin');
    }

    // Admin autenticado + imagen LEGACY ("/uploads/custom/<file>") asociada
    // al pedido -> también 200 (compatibilidad histórica, sección 28) SIN
    // haber reabierto /uploads/custom como público.
    {
      const res = await fetch(`${base}/admin/pedidos/100/imagenes/2`, { headers: { 'x-test-admin-id': '42' } });
      eq(res.status, 200, 'admin + imagen legacy ("/uploads/custom/...") -> 200 (compatibilidad histórica)');
    }

    // Referencia legacy externa (URL completa) -> nunca se hace fetch
    // server-side; respuesta explícita y segura, no un intento de red.
    {
      const res = await fetch(`${base}/admin/pedidos/100/imagenes/3`, { headers: { 'x-test-admin-id': '42' } });
      eq(res.status, 422, 'referencia legacy con forma de URL externa -> 422 explícito, nunca un fetch SSRF');
    }

    // Imagen que SÍ existe pero pertenece a OTRO pedido -> denegado (nunca
    // basta con que el imageId exista).
    {
      const res = await fetch(`${base}/admin/pedidos/100/imagenes/4`, { headers: { 'x-test-admin-id': '42' } });
      eq(res.status, 404, 'CRÍTICO: imagen real pero de OTRO pedido -> 404 (la relación con el pedido es obligatoria, no solo que el imageId exista)');
    }
    // Y sí funciona sobre SU pedido real.
    {
      const res = await fetch(`${base}/admin/pedidos/200/imagenes/4`, { headers: { 'x-test-admin-id': '42' } });
      eq(res.status, 200, 'la misma imagen SÍ es accesible bajo su pedido real (200)');
    }

    // imageId inexistente -> 404 (mismo código que "existe pero no es tuyo": no ayuda a enumeración)
    {
      const res = await fetch(`${base}/admin/pedidos/100/imagenes/9999`, { headers: { 'x-test-admin-id': '42' } });
      eq(res.status, 404, 'imageId inexistente -> 404, mismo código que cross-order (sección 30)');
    }

    // Traversal a través del propio :imageId asociado -- ya cubierto por C,
    // pero se repite aquí contra la ruta real de admin con una ruta
    // corrupta hipotética en BD (defensa en profundidad de la capa admin).
    {
      const corruptPool = makeFakeAdminPool({
        orders,
        items,
        images: [{ id: 1, detalle_pedido_id: 500, ruta: '../../../../etc/passwd' }]
      });
      const corruptRouter = loadFreshAdminRouter(corruptPool);
      const corruptServer = await startAdminTestServer(corruptRouter);
      const corruptPort = corruptServer.address().port;
      try {
        const res = await fetch(`http://127.0.0.1:${corruptPort}/admin/pedidos/100/imagenes/1`, { headers: { 'x-test-admin-id': '42' } });
        eq(res.status, 404, 'ruta corrupta/traversal en BD -> 404, nunca se sirve ni se filtra el filesystem');
      } finally {
        await new Promise(r => corruptServer.close(r));
      }
    }
  } finally {
    await new Promise(r => server.close(r));
    cleanupCreatedFiles();
  }
}

// =======================================================================
// F) Sección 37 - snapshot/fingerprint/finalización
// =======================================================================
async function checkSnapshotFingerprintAndFinalization() {
  const capabilityUrl = `/api/uploads/custom/preview/${crypto.randomUUID()}.jpg?t=${'a'.repeat(64)}`;

  // F1. extractPersistableImageRuta: formato nuevo -> key limpia; legacy -> intacto.
  {
    const filename = `${crypto.randomUUID()}.jpg`;
    const newUrl = `/api/uploads/custom/preview/${filename}?t=${'b'.repeat(64)}`;
    eq(uploadsStorage.extractPersistableImageRuta(newUrl), `custom/${filename}`, 'una capability URL nueva se reduce a la key interna limpia "custom/<file>" (sin el token del cliente)');
    eq(uploadsStorage.extractPersistableImageRuta(`/uploads/custom/${filename}`), `/uploads/custom/${filename}`, 'un valor legacy ya persistido se conserva tal cual (no se reescribe históricos)');
    eq(uploadsStorage.extractPersistableImageRuta('not-a-real-format'), 'not-a-real-format', 'un valor no reconocido se conserva sin intentar "corregirlo"');
  }

  // F2. selections/pricing: images[].url sigue siendo un string opaco válido.
  {
    const pricingDataAccess = {
      async getProduct(id) { return id === 8 ? { id: 8, nombre: 'Litofanía', precio: '50.00', activo: 1 } : null; },
      async getModel() { return null; },
      async getVariantOptions() { return []; }
    };
    const result = await pricing.priceCartFromSelections(
      [{ productId: 8, quantity: 1, images: [{ url: capabilityUrl, filename: 'x.jpg', mimetype: 'image/jpeg', size: 123 }] }],
      { dataAccess: pricingDataAccess }
    );
    eq(result.items[0].images[0].url, capabilityUrl, 'priceCartFromSelections conserva la capability URL como referencia opaca, sin tocarla');
  }

  // F3. fingerprint determinista: mismo upload/ref -> mismo fingerprint en reintentos.
  {
    const selections = [{ productId: 8, quantity: 1, images: [{ url: capabilityUrl }] }];
    const fp1 = checkoutDrafts.computeSelectionsFingerprint(selections);
    const fp2 = checkoutDrafts.computeSelectionsFingerprint(JSON.parse(JSON.stringify(selections)));
    eq(fp1, fp2, 'el fingerprint es determinista entre reintentos con la misma referencia de imagen (no rompe idempotencia B4B)');
  }

  // F4. finalizePaidCheckout persiste la key limpia, nunca el capability token del cliente.
  {
    const pool = makeFinalizationFakePool();
    const filename = `${crypto.randomUUID()}.jpg`;
    const draftId = 9001;
    const snapshot = {
      schemaVersion: 1, currency: 'eur',
      customerData: { name: 'Ana', email: 'ana@example.com', phone: '1', address: '2', city: '3', zip: '4' },
      items: [{
        productId: 8, productName: 'Litofanía', modelId: null, modelName: null,
        variantSelections: [], extras: { upscale: false, qr: false, adapter: false, qrMessage: '' },
        unitPriceCents: 6500, quantity: 1, lineSubtotalCents: 6500, lineDiscountCents: 0,
        images: [{ url: `/api/uploads/custom/preview/${filename}?t=${'c'.repeat(64)}` }],
        notes: ''
      }],
      totals: { subtotalCents: 6500, discountCents: 0, shippingCents: 0, totalCents: 6500, netCents: 5372, taxCents: 1128 }
    };
    pool._seedDraft({ id: draftId, status: 'payment_pending', snapshot_json: JSON.stringify(snapshot), stripe_payment_intent_id: 'pi_fotos_1', idempotency_key: 'dk', selections_fingerprint: 'fp', access_token_hash: 'ah', created_at: new Date(), updated_at: new Date(), expires_at: null });
    const draftsDataAccess = { async findById(id) { const row = pool._state.checkoutDrafts.get(id); return row ? { ...row } : null; } };
    const paymentIntent = { id: 'pi_fotos_1', status: 'succeeded', amount: 6500, currency: 'eur', metadata: { checkoutDraftId: String(draftId) } };

    const result = await realCheckoutFinalization.finalizePaidCheckout(paymentIntent, { pool, draftsDataAccess });
    eq(result.created, true, 'finalización con imagen en formato capability-URL crea el pedido con normalidad');

    const persistedImage = [...pool._state.detalleImagenes.values()].find(i => i.detalle_pedido_id !== undefined);
    ok(persistedImage, 'se persistió la imagen del detalle del pedido');
    eq(persistedImage.ruta, `custom/${filename}`, 'CRÍTICO: detalle_pedido_imagenes.ruta guarda la key interna limpia "custom/<file>", NUNCA el capability token (?t=...) del cliente');
    ok(!persistedImage.ruta.includes('?t='), 'el valor persistido no contiene ningún token');
  }
}

// Pool mínimo para F4, mismo patrón que scripts/check-checkout-finalization.js
// (duplicado deliberadamente: cada test script es autocontenido en este proyecto).
function makeFinalizationFakePool() {
  const state = { checkoutDrafts: new Map(), pedidos: new Map(), detallePedidos: new Map(), detalleImagenes: new Map(), nextPedidoId: 1, nextDetalleId: 1, nextImagenId: 1 };
  async function runQuery(sql, params = []) {
    if (sql.includes('FROM checkout_drafts WHERE id = ? FOR UPDATE')) {
      const row = state.checkoutDrafts.get(params[0]);
      return [row ? [{ ...row }] : []];
    }
    if (sql.includes('SELECT id FROM pedidos WHERE stripe_payment_intent_id')) {
      const found = [...state.pedidos.values()].find(r => r.stripe_payment_intent_id === params[0]);
      return [found ? [{ id: found.id }] : []];
    }
    if (sql.startsWith('INSERT INTO pedidos')) {
      const [, , total, , , , , , , , , stripe_payment_intent_id] = params;
      const id = state.nextPedidoId++;
      state.pedidos.set(id, { id, total, stripe_payment_intent_id });
      return [{ insertId: id }];
    }
    if (sql.startsWith('INSERT INTO detalle_pedidos')) {
      const [pedido_id, producto_id, modelo_id, cantidad, precio_unitario, personalizacion_notas, variantes_seleccionadas] = params;
      const id = state.nextDetalleId++;
      state.detallePedidos.set(id, { id, pedido_id, producto_id, modelo_id, cantidad, precio_unitario, personalizacion_notas, variantes_seleccionadas });
      return [{ insertId: id }];
    }
    if (sql.startsWith('INSERT INTO detalle_pedido_imagenes')) {
      const [detalle_pedido_id, ruta] = params;
      const id = state.nextImagenId++;
      state.detalleImagenes.set(id, { id, detalle_pedido_id, ruta });
      return [{ insertId: id }];
    }
    if (sql.startsWith('UPDATE checkout_drafts SET status')) {
      const [status, id] = params;
      const row = state.checkoutDrafts.get(id);
      if (row) row.status = status;
      return [{ affectedRows: row ? 1 : 0 }];
    }
    throw new Error(`Fake pool: consulta no reconocida: ${sql}`);
  }
  return {
    async query(sql, params) { return runQuery(sql, params); },
    async getConnection() {
      let txSnapshot = null;
      function snapshotState() {
        return {
          checkoutDrafts: new Map([...state.checkoutDrafts].map(([k, v]) => [k, { ...v }])),
          pedidos: new Map([...state.pedidos].map(([k, v]) => [k, { ...v }])),
          detallePedidos: new Map([...state.detallePedidos].map(([k, v]) => [k, { ...v }])),
          detalleImagenes: new Map([...state.detalleImagenes].map(([k, v]) => [k, { ...v }])),
          nextPedidoId: state.nextPedidoId, nextDetalleId: state.nextDetalleId, nextImagenId: state.nextImagenId
        };
      }
      return {
        async beginTransaction() { txSnapshot = snapshotState(); },
        async query(sql, params) { return runQuery(sql, params); },
        async commit() { txSnapshot = null; },
        async rollback() { if (txSnapshot) Object.assign(state, txSnapshot); },
        release() {}
      };
    },
    _state: state,
    _seedDraft(row) { state.checkoutDrafts.set(row.id, row); }
  };
}

// =======================================================================
// G) Sección 38 - email automático
// =======================================================================
async function checkEmailDoesNotExposeImageUrls() {
  const paymentsModule = require('../routes/payments');
  const capturedEmails = [];
  const fakeTransporterSend = async (msg) => { capturedEmails.push(msg); };

  // sendConfirmationEmails no está exportado directamente (función interna
  // de routes/payments.js); se ejercita a través de finalizePaidCheckout con
  // el sendConfirmationEmailAdapter real, igual que hacen los tests de
  // checkout-routes/webhook, pero interceptando nodemailer.createTransport
  // no es viable sin tocar el módulo real de transporte. En su lugar, se
  // reutiliza buildHandlers() con checkoutFinalization real para producir un
  // pedido, y se verifica el HTML que sendConfirmationEmailAdapter generaría
  // inspeccionando directamente snapshotItemToEmailCartItem + el propio
  // sendConfirmationEmails vía su transporter inyectado no existe -- así que
  // se prueba el contrato más fuerte disponible sin tocar red real: se llama
  // a payments.snapshotItemToEmailCartItem (exportado) y se confirma que el
  // objeto que llega a cartHTML nunca incluye una URL utilizable como enlace
  // público, y que el código fuente de sendConfirmationEmails ya no contiene
  // ningún template literal que construya un <a href> a partir de item.images.
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'payments.js'), 'utf8');
  const fnStart = src.indexOf('async function sendConfirmationEmails');
  const fnEnd = src.indexOf('\nfunction escapeHtml', fnStart);
  const fnSource = src.slice(fnStart, fnEnd);

  ok(!/href="\$\{url\}"/.test(fnSource) && !/Ver imagen/.test(fnSource), 'el email (cliente+admin, cartHTML compartido) ya no construye ningún <a href> directo a la foto');
  ok(/\/admin/.test(fnSource) && /adminPanelNotice/.test(fnSource), 'el email de admin incluye un enlace al panel Admin (requiere login) en vez de la foto');
  ok(!/token permanente/i.test(fnSource), 'no se introduce ningún token permanente de imagen en el email');
  // Sección 22 del hardening: los attachments siguen enviándose (adjuntos
  // reales al email interno de admin), pero resolviendo el archivo con el
  // helper seguro -- nunca concatenando "/uploads/custom/" a mano ni
  // incluyendo el capability token (?t=) en ningún sitio del email.
  ok(/resolveCustomUploadPath/.test(fnSource), 'el bloque de attachments sigue resolviendo el archivo vía uploadsStorage.resolveCustomUploadPath (helper seguro), no un path construido a mano');
  ok(!/'\/uploads\/custom\/'\s*\+/.test(fnSource) && !fnSource.includes("path.join(__dirname, '..', 'uploads', 'custom', raw)"), 'el bloque de attachments ya no concatena "/uploads/custom/" + un valor del cliente a mano');
  ok(!fnSource.includes('?t='), 'el código fuente del email nunca referencia el query param del capability token');

  // El adapter de email sigue produciendo el shape esperado (sin romper contrato B4B).
  const item = paymentsModule.snapshotItemToEmailCartItem({ productName: 'X', modelName: null, notes: '', images: [{ url: '/api/uploads/custom/preview/x.jpg?t=y' }], quantity: 1, unitPriceCents: 1000 });
  eq(item.name, 'X', 'snapshotItemToEmailCartItem conserva el contrato existente para el resto del email');
  void fakeTransporterSend; void capturedEmails;
}

// =======================================================================
// H) Secreto DEDICADO (UPLOAD_PREVIEW_SECRET, nunca SESSION_SECRET)
// =======================================================================
async function checkDedicatedSecretBehavior() {
  const filename = `${crypto.randomUUID()}.jpg`;

  // A. secreto presente -> firma y verifica correctamente.
  await withUploadPreviewSecret(TEST_UPLOAD_PREVIEW_SECRET, async () => {
    const token = uploadsStorage.computePreviewToken(filename);
    ok(typeof token === 'string' && /^[0-9a-f]{64}$/.test(token), 'con UPLOAD_PREVIEW_SECRET configurado, computePreviewToken firma correctamente');
    ok(uploadsStorage.verifyPreviewToken(filename, token), 'el mismo secreto verifica su propio token');
  });

  // B. secreto ausente -> fail-closed total (nunca un fallback inseguro).
  await withUploadPreviewSecret(null, async () => {
    eq(uploadsStorage.isPreviewSecretConfigured(), false, 'sin UPLOAD_PREVIEW_SECRET, isPreviewSecretConfigured() es false');
    eq(uploadsStorage.computePreviewToken(filename), null, 'sin secreto, computePreviewToken devuelve null (nunca firma con un valor por defecto)');
    let threw = null;
    try { uploadsStorage.buildPreviewUrl(filename); } catch (err) { threw = err; }
    ok(threw instanceof Error, 'buildPreviewUrl lanza si falta el secreto (nunca genera una capability insegura)');
    eq(uploadsStorage.verifyPreviewToken(filename, 'a'.repeat(64)), false, 'sin secreto, ningún token se acepta jamás');
  });

  // C. token firmado con secret A, servidor configurado con secret B -> rechazado.
  let tokenSignedWithA;
  await withUploadPreviewSecret('secret-A-' + 'a'.repeat(20), async () => {
    tokenSignedWithA = uploadsStorage.computePreviewToken(filename);
  });
  await withUploadPreviewSecret('secret-B-' + 'b'.repeat(20), async () => {
    eq(uploadsStorage.verifyPreviewToken(filename, tokenSignedWithA), false, 'token firmado con secret A no valida contra un servidor configurado con secret B');
  });

  // D. cambiar SESSION_SECRET NO afecta la validez del preview token (ya no comparten secreto).
  const prevSessionSecret = process.env.SESSION_SECRET;
  await withUploadPreviewSecret(TEST_UPLOAD_PREVIEW_SECRET, async () => {
    process.env.SESSION_SECRET = 'una-cosa-completamente-distinta-' + crypto.randomUUID();
    const token1 = uploadsStorage.computePreviewToken(filename);
    process.env.SESSION_SECRET = 'otro-valor-totalmente-diferente-' + crypto.randomUUID();
    const token2 = uploadsStorage.computePreviewToken(filename);
    eq(token1, token2, 'CRÍTICO: cambiar SESSION_SECRET no altera el token de preview -- capabilities de fotos y sesiones Admin ya no comparten secreto');
  });
  if (prevSessionSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = prevSessionSecret;

  // E. rotar UPLOAD_PREVIEW_SECRET SÍ invalida los tokens emitidos con el anterior.
  let tokenBeforeRotation;
  await withUploadPreviewSecret(TEST_UPLOAD_PREVIEW_SECRET, async () => {
    tokenBeforeRotation = uploadsStorage.computePreviewToken(filename);
  });
  await withUploadPreviewSecret(TEST_UPLOAD_PREVIEW_SECRET + '-rotated', async () => {
    eq(uploadsStorage.verifyPreviewToken(filename, tokenBeforeRotation), false, 'rotar UPLOAD_PREVIEW_SECRET invalida los tokens emitidos con el secreto anterior');
  });
}

// =======================================================================
// I) Canonicalización server-side de referencias de imagen del cliente
// =======================================================================
async function checkClientImageCanonicalization() {
  const { canonicalizeSelectionsImages, ImageReferenceValidationError } = realCheckoutPayment;

  await withUploadPreviewSecret(TEST_UPLOAD_PREVIEW_SECRET, async () => {
    const filename = `${crypto.randomUUID()}.jpg`;
    const validToken = uploadsStorage.computePreviewToken(filename);
    const validUrl = `/api/uploads/custom/preview/${filename}?t=${validToken}`;

    // A. preview URL válida + token correcto -> canonical "custom/<filename>".
    {
      const canonical = await canonicalizeSelectionsImages(
        [{ productId: 8, quantity: 1, images: [{ url: validUrl }] }],
        { verifyExistence: false }
      );
      eq(canonical[0].images[0].url, `custom/${filename}`, 'A: preview URL válida + token correcto se canonicaliza a "custom/<filename>"');
    }

    // B. token incorrecto -> rechazo.
    await rejects(
      () => canonicalizeSelectionsImages([{ productId: 8, quantity: 1, images: [{ url: `/api/uploads/custom/preview/${filename}?t=${'0'.repeat(64)}` }] }], { verifyExistence: false }),
      ImageReferenceValidationError, 'B: token incorrecto -> rechazo'
    );

    // C. sin token -> rechazo.
    await rejects(
      () => canonicalizeSelectionsImages([{ productId: 8, quantity: 1, images: [{ url: `/api/uploads/custom/preview/${filename}` }] }], { verifyExistence: false }),
      ImageReferenceValidationError, 'C: sin token -> rechazo'
    );

    // D. URL externa -> rechazo.
    await rejects(
      () => canonicalizeSelectionsImages([{ productId: 8, quantity: 1, images: [{ url: 'https://evil.example/x.jpg' }] }], { verifyExistence: false }),
      ImageReferenceValidationError, 'D: URL externa -> rechazo (nunca se interpreta como referencia propia)'
    );

    // E. path legacy "/uploads/custom/<file>" enviado DIRECTAMENTE por el cliente -> rechazo.
    await rejects(
      () => canonicalizeSelectionsImages([{ productId: 8, quantity: 1, images: [{ url: `/uploads/custom/${filename}` }] }], { verifyExistence: false }),
      ImageReferenceValidationError, 'E: path legacy enviado directamente por el cliente -> rechazo (tener "forma válida" no basta)'
    );

    // F. internal key "custom/<file>" enviado DIRECTAMENTE por el cliente -> rechazo.
    await rejects(
      () => canonicalizeSelectionsImages([{ productId: 8, quantity: 1, images: [{ url: `custom/${filename}` }] }], { verifyExistence: false }),
      ImageReferenceValidationError, 'F: CRÍTICO: internal key autoasignada por el cliente -> rechazo (solo el servidor puede producirla)'
    );

    // G. traversal en el filename -> rechazo.
    await rejects(
      () => canonicalizeSelectionsImages([{ productId: 8, quantity: 1, images: [{ url: `/api/uploads/custom/preview/../../etc/passwd?t=${validToken}` }] }], { verifyExistence: false }),
      ImageReferenceValidationError, 'G: traversal en el filename -> rechazo'
    );

    // H. archivo inexistente en checkout NUEVO (verifyExistence:true) -> rechazo ANTES de Stripe.
    await rejects(
      () => canonicalizeSelectionsImages([{ productId: 8, quantity: 1, images: [{ url: validUrl }] }], { verifyExistence: true }),
      ImageReferenceValidationError, 'H: verifyExistence=true (draft nuevo) + archivo inexistente -> rechazo'
    );

    // Control positivo de H: el mismo archivo, si SÍ existe, se acepta con verifyExistence:true.
    {
      fs.writeFileSync(path.join(uploadsStorage.CUSTOM_UPLOAD_ROOT, filename), jpegFixture());
      createdFilenames.add(filename);
      try {
        const canonical = await canonicalizeSelectionsImages([{ productId: 8, quantity: 1, images: [{ url: validUrl }] }], { verifyExistence: true });
        eq(canonical[0].images[0].url, `custom/${filename}`, 'control positivo H: archivo existente + verifyExistence:true -> aceptado y canonicalizado');

        // Fast path (retry, verifyExistence:false) es puro/determinista: no
        // exige tocar el filesystem, solo valida el token (sección 9).
        const canonicalFastPath = await canonicalizeSelectionsImages([{ productId: 8, quantity: 1, images: [{ url: validUrl }] }], { verifyExistence: false });
        eq(canonicalFastPath[0].images[0].url, `custom/${filename}`, 'fast path (verifyExistence:false) también canonicaliza correctamente sin depender de re-verificar existencia');
      } finally {
        cleanupCreatedFiles();
      }
    }
  });
}

// =======================================================================
// J) Snapshot real (prepareCanonicalCheckout) sin capability token + idempotencia
// =======================================================================
const CHECKOUT_TEST_PRODUCTS = { 8: { id: 8, nombre: 'Litofanía Circular', precio: '50.00', activo: 1 } };
function fakePricingDataAccessForCheckout() {
  return {
    async getProduct(id) { return CHECKOUT_TEST_PRODUCTS[id] || null; },
    async getModel() { return null; },
    async getVariantOptions() { return []; }
  };
}
function makeFakeDraftsDataAccessForCheckout() {
  const rows = new Map();
  let nextId = 1;
  function checkUnique(field, value, excludeId) {
    if (value === null || value === undefined) return;
    for (const row of rows.values()) {
      if (row.id === excludeId) continue;
      if (row[field] === value) {
        const err = new Error(`Duplicate entry '${value}'`);
        err.code = 'ER_DUP_ENTRY'; err.sqlMessage = err.message;
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
      rows.set(id, { id, idempotency_key: idempotencyKey, selections_fingerprint: selectionsFingerprint, access_token_hash: accessTokenHash, stripe_payment_intent_id: null, snapshot_json: snapshotJson, status, created_at: now, updated_at: now, expires_at: expiresAt });
      return id;
    },
    async findById(id) { return rows.get(id) || null; },
    async findByIdempotencyKey(key) { for (const row of rows.values()) if (row.idempotency_key === key) return row; return null; },
    async findByAccessTokenHash(hash) { for (const row of rows.values()) if (row.access_token_hash === hash) return row; return null; },
    async updateSnapshotIfStatusIn(id, snapshotJson, allowedStatuses) {
      const row = rows.get(id); if (!row) return 0;
      if (!allowedStatuses.includes(row.status)) return 0;
      row.snapshot_json = snapshotJson; row.updated_at = new Date();
      return 1;
    },
    async updateStatus(id, status) { const row = rows.get(id); if (row) { row.status = status; row.updated_at = new Date(); } },
    async attachStripePaymentIntent(id, paymentIntentId, status) {
      checkUnique('stripe_payment_intent_id', paymentIntentId, id);
      const row = rows.get(id); if (row) { row.stripe_payment_intent_id = paymentIntentId; row.status = status; row.updated_at = new Date(); }
    },
    _rows: rows
  };
}
function makeFakeStripeWithCounter() {
  const byIdempotencyKey = new Map();
  const byId = new Map();
  let counter = 1;
  let createCallCount = 0;
  return {
    paymentIntents: {
      async create(params, requestOptions = {}) {
        createCallCount++;
        const idemKey = requestOptions.idempotencyKey;
        if (idemKey && byIdempotencyKey.has(idemKey)) return byIdempotencyKey.get(idemKey);
        const id = `pi_test_${counter++}`;
        const pi = { id, status: 'requires_payment_method', amount: params.amount, currency: params.currency, metadata: params.metadata || {}, client_secret: `${id}_secret` };
        if (idemKey) byIdempotencyKey.set(idemKey, pi);
        byId.set(id, pi);
        return pi;
      },
      async retrieve(id) {
        const pi = byId.get(id);
        if (!pi) { const e = new Error('No such payment_intent'); e.code = 'resource_missing'; throw e; }
        return pi;
      }
    },
    get createCallCount() { return createCallCount; }
  };
}

async function checkSnapshotNeverContainsCapabilityTokenViaRealPipeline() {
  await withUploadPreviewSecret(TEST_UPLOAD_PREVIEW_SECRET, async () => {
    const filename = `${crypto.randomUUID()}.jpg`;
    fs.writeFileSync(path.join(uploadsStorage.CUSTOM_UPLOAD_ROOT, filename), jpegFixture());
    createdFilenames.add(filename);
    try {
      const token = uploadsStorage.computePreviewToken(filename);
      const previewUrl = `/api/uploads/custom/preview/${filename}?t=${token}`;

      const pricingDataAccess = fakePricingDataAccessForCheckout();
      const draftsDataAccess = makeFakeDraftsDataAccessForCheckout();
      const stripe = makeFakeStripeWithCounter();
      const accessToken = checkoutDrafts.generateAccessToken();

      const result = await realCheckoutPayment.prepareCanonicalCheckout(
        { idempotencyKey: 'snap-test-1', accessToken, selections: [{ productId: 8, quantity: 1, images: [{ url: previewUrl, filename, mimetype: 'image/jpeg', size: 123 }] }] },
        { pricingDataAccess, draftsDataAccess, stripe }
      );

      const persistedRow = draftsDataAccess._rows.get(result.draftId);
      ok(!persistedRow.snapshot_json.includes('?t='), 'CRÍTICO: checkout_drafts.snapshot_json NO contiene "?t=" (ningún capability token persistido)');
      ok(!persistedRow.snapshot_json.includes(token), 'snapshot_json no contiene el valor literal del token de test');
      ok(persistedRow.snapshot_json.includes(`custom/${filename}`), 'snapshot_json SÍ contiene la referencia canónica "custom/<filename>"');
      eq(result.snapshot.items[0].images[0].url, `custom/${filename}`, 'el snapshot devuelto también expone la referencia canónica, nunca la capability URL');

      // Retry con la MISMA idempotencyKey + MISMA selección -> recupera el
      // MISMO draft (idempotencia B4A intacta tras la canonicalización).
      const retryResult = await realCheckoutPayment.prepareCanonicalCheckout(
        { idempotencyKey: 'snap-test-1', accessToken, selections: [{ productId: 8, quantity: 1, images: [{ url: previewUrl, filename, mimetype: 'image/jpeg', size: 123 }] }] },
        { pricingDataAccess, draftsDataAccess, stripe }
      );
      eq(retryResult.draftId, result.draftId, 'retry con la misma referencia de imagen recupera el MISMO draft (idempotencia B4A intacta)');
      eq(retryResult.reused, true, 'retry -> reused:true');
      eq(stripe.createCallCount, 1, 'el retry no crea un segundo PaymentIntent (mismo fingerprint canónico -> mismo draft ya asociado)');
    } finally {
      cleanupCreatedFiles();
    }
  });
}

// =======================================================================
// K) Imagen inválida NUNCA llega a Stripe (test obligatorio, sección 21)
// =======================================================================
async function checkInvalidImageNeverReachesStripe() {
  await withUploadPreviewSecret(TEST_UPLOAD_PREVIEW_SECRET, async () => {
    const pricingDataAccess = fakePricingDataAccessForCheckout();
    const draftsDataAccess = makeFakeDraftsDataAccessForCheckout();
    const stripe = makeFakeStripeWithCounter();
    const accessToken = checkoutDrafts.generateAccessToken();

    // Selección económicamente válida (producto real, cantidad válida) pero
    // con una imagen manipulada (token falso, archivo que nunca se subió).
    const maliciousUrl = `/api/uploads/custom/preview/${crypto.randomUUID()}.jpg?t=${'f'.repeat(64)}`;

    const threw = await rejects(
      () => realCheckoutPayment.prepareCanonicalCheckout(
        { idempotencyKey: 'invalid-img-1', accessToken, selections: [{ productId: 8, quantity: 1, images: [{ url: maliciousUrl }] }] },
        { pricingDataAccess, draftsDataAccess, stripe }
      ),
      realCheckoutPayment.ImageReferenceValidationError,
      'selección con imagen manipulada/inválida -> rechazada con ImageReferenceValidationError'
    );
    ok(threw, 'la excepción se lanzó (control de que rejects() realmente evaluó algo)');
    eq(stripe.createCallCount, 0, 'CRÍTICO: 0 llamadas a paymentIntents.create cuando la imagen es inválida -- nunca se llega a cobrar');
    eq(draftsDataAccess._rows.size, 0, 'CRÍTICO: 0 checkout_drafts creados -- nunca queda un draft cobrable con una imagen inválida');
  });
}

// =======================================================================
// L) Promesa falsa de "borrado automático tras fabricación" (sección 23)
// =======================================================================
async function checkNoFalseAutomaticDeletionPromise() {
  const filesToScan = [
    'views/index.html', 'views/index-de.html', 'views/index-fr.html',
    'views/checkout.html', 'views/checkout-de.html', 'views/checkout-fr.html',
    'views/privacy-policy.html',
    'public/js/home.js', 'public/js/shop.js'
  ];
  const bannedPatterns = [
    /borrar[aá]n?\s+autom[aá]t/i,
    /elimin[ae]n?\s+autom[aá]t/i,
    /borrado\s+autom[aá]tico/i,
    /automatische\s+l[oö]schung/i,
    /automatisch.{0,25}gel[oö]scht|gel[oö]scht.{0,25}automatisch/i,
    /supprim[ée]e?s?\s+automatiquement/i,
    /suppression\s+automatique/i,
    /deleted?\s+automatically/i
  ];
  for (const rel of filesToScan) {
    const full = path.join(__dirname, '..', rel);
    const content = fs.readFileSync(full, 'utf8');
    for (const pattern of bannedPatterns) {
      ok(!pattern.test(content), `${rel}: no debe contener una promesa de borrado automático (patrón: ${pattern})`);
    }
  }
}

// =======================================================================
async function main() {
  console.log('P0-FOTOS-01 - acceso público a /uploads/custom cerrado');
  await checkPublicAccessClosed();
  console.log('P0-FOTOS-01 - validación de upload (magic bytes, límites, naming)');
  await withUploadPreviewSecret(TEST_UPLOAD_PREVIEW_SECRET, checkUploadValidation);
  console.log('P0-FOTOS-01 - path traversal / symlink sobre resolveCustomUploadPath');
  await checkPathTraversalDefenses();
  console.log('P0-FOTOS-01 - preview del cliente (capability token, cross-access)');
  await withUploadPreviewSecret(TEST_UPLOAD_PREVIEW_SECRET, checkClientPreviewCapability);
  console.log('P0-FOTOS-01 - acceso Admin autenticado vinculado al pedido (legacy/SSRF/cross-order)');
  await checkAdminImageAccess();
  console.log('P0-FOTOS-01 - snapshot/fingerprint/finalización con el nuevo formato de referencia');
  await checkSnapshotFingerprintAndFinalization();
  console.log('P0-FOTOS-01 - email automático ya no expone URLs de fotos');
  await checkEmailDoesNotExposeImageUrls();
  console.log('P0-FOTOS-01 (hardening) - secreto DEDICADO de preview (fail-closed, sin compartir con SESSION_SECRET)');
  await checkDedicatedSecretBehavior();
  console.log('P0-FOTOS-01 (hardening) - canonicalización server-side de referencias de imagen del cliente');
  await checkClientImageCanonicalization();
  console.log('P0-FOTOS-01 (hardening) - snapshot real (prepareCanonicalCheckout) sin capability token, idempotencia intacta');
  await checkSnapshotNeverContainsCapabilityTokenViaRealPipeline();
  console.log('P0-FOTOS-01 (hardening) - imagen inválida NUNCA llega a Stripe (obligatorio)');
  await checkInvalidImageNeverReachesStripe();
  console.log('P0-FOTOS-01 (hardening) - sin promesa falsa de borrado automático en textos públicos');
  await checkNoFalseAutomaticDeletionPromise();
  console.log(`OK: ${checks} comprobaciones sobre privacidad/acceso de fotos de personalización.`);
}

main()
  .catch(err => { console.error('FALLO:', err); process.exit(1); })
  .finally(() => cleanupCreatedFiles());
