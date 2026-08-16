/*
  LITUM3D - Storage privado de fotografías personalizadas (P0-FOTOS-01).

  Las fotos que un cliente sube en el configurador (routes/uploads.js) son
  datos privados: NUNCA deben quedar accesibles mediante una URL pública
  estable. Este módulo centraliza:

    - dónde viven físicamente los archivos (uploads/custom, FUERA de
      cualquier express.static -- ver server.js);
    - cómo se detecta el tipo real de un archivo subido (magic bytes, no el
      mimetype que declara el navegador ni la extensión del cliente);
    - cómo se genera el nombre físico de un archivo NUEVO (crypto.randomUUID(),
      nunca originalname/timestamp/IDs secuenciales);
    - cómo se resuelve de forma segura un nombre de archivo (propio o
      histórico) a una ruta real dentro de uploads/custom, sin permitir path
      traversal ni symlink escape;
    - el capability token (HMAC, sin estado/schema nuevo) que autoriza al
      propio cliente anónimo a previsualizar SU imagen antes/durante el
      checkout, sin depender del checkout accessToken (el upload puede
      existir antes de que exista ningún checkout_draft).

  Dos consumidores:
    - routes/uploads.js: sube archivos nuevos y sirve el preview con
      capability token (canal del cliente, pre-checkout).
    - routes/admin.js: sirve imágenes ya asociadas a un pedido, protegido por
      sesión de admin (requireAuth), sin necesitar el capability token.
*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CUSTOM_UPLOAD_ROOT = path.join(__dirname, '..', 'uploads', 'custom');

// --- Tipos permitidos --------------------------------------------------------
// Confirmado contra el frontend real (views/*.html, input#custom-files):
// accept="image/jpeg,image/png" en TODOS los formularios de personalización
// (shop/home, ES/DE/FR). No se soporta WEBP en ningún punto del pipeline
// actual (frontend, multer, pricing.js) -- no se añade sin necesidad real.
const MIME_TO_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png' };
const EXT_TO_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };

// Límite server-side (sección 11): no existe compresión/resizing en el
// frontend actual (shop.js/home.js suben el File tal cual), así que el
// límite debe acomodar fotos de móvil modernas sin comprimir (típicamente
// 3-15MB en JPEG de cámaras de 12-48MP). 10MB por archivo, máx. 3 archivos
// (sin cambios respecto al límite de cantidad ya existente).
const MAX_UPLOAD_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_FILES = 3;

// --- Magic bytes (sección 10) ------------------------------------------------
// Sin dependencia nueva: Node ya trae todo lo necesario para comprobar la
// firma real de JPEG/PNG. No se confía en el mimetype que declara el
// navegador (file.mimetype de multer) ni en la extensión del nombre
// original: ambos son datos que el cliente controla.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function detectImageMimeType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (PNG_SIGNATURE.every((byte, idx) => buffer[idx] === byte)) return 'image/png';
  return null;
}

// --- Nombre físico de archivos NUEVOS (sección 7) ---------------------------
// crypto.randomUUID(): identificador criptográficamente aleatorio, sin
// relación alguna con originalname/email/teléfono/dirección/orderId/timestamp.
// La extensión se deriva SIEMPRE del tipo detectado por magic bytes, nunca
// del nombre que envía el cliente.
function generateUploadFilename(detectedMimeType) {
  const ext = MIME_TO_EXT[detectedMimeType];
  if (!ext) {
    throw new Error(`Tipo de imagen no soportado para generar nombre: ${detectedMimeType}`);
  }
  return `${crypto.randomUUID()}.${ext}`;
}

// Acepta tanto los nombres UUID que genera generateUploadFilename como los
// nombres legacy `${Date.now()}-${randomHex}.ext` que ya existen físicamente
// en uploads/custom de antes de este ticket (sección 28: no se renombran/
// migran archivos reales). Charset y longitud acotados a propósito: cualquier
// cosa fuera de esto (separadores de path, "..", null bytes, extensiones no
// admitidas) se rechaza aquí, ANTES de tocar el filesystem.
const SAFE_UPLOAD_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(jpg|jpeg|png)$/;

function isValidCustomUploadFilename(name) {
  return typeof name === 'string' && SAFE_UPLOAD_FILENAME_RE.test(name);
}

function contentTypeForFilename(filename) {
  const ext = path.extname(filename).toLowerCase().replace(/^\./, '');
  return EXT_TO_MIME[ext] || null;
}

// --- Resolución segura de path (secciones 8/9/30) ---------------------------
// Nunca hace algo equivalente a sendFile(req.params.filename) directo:
// 1) basename() descarta cualquier componente de directorio -- si el valor
//    original traía "/", "\", ".." o era un path absoluto, el resultado NO
//    coincide con el original y se rechaza (en vez de "corregirlo" en
//    silencio, que podría reinterpretar un valor ambiguo).
// 2) se valida contra el charset/patrón permitido.
// 3) el join resuelto debe seguir bajo la raíz esperada (cinturón y
//    tirantes junto al basename).
// 4) fs.realpath resuelve symlinks: si el resultado real cae fuera de la
//    raíz real (symlink escape), se rechaza igualmente.
// Cualquier fallo (no existe, traversal, symlink escape, permiso, null byte)
// se colapsa a `null`: el caller responde 404 genérico, sin distinguir
// motivos (sección 30 -- no ayudar a enumeración).
async function resolveCustomUploadPath(rawFilename) {
  try {
    if (typeof rawFilename !== 'string' || rawFilename.length === 0) return null;
    const safeName = path.basename(rawFilename);
    if (safeName !== rawFilename || !isValidCustomUploadFilename(safeName)) return null;

    const candidate = path.join(CUSTOM_UPLOAD_ROOT, safeName);
    if (!candidate.startsWith(CUSTOM_UPLOAD_ROOT + path.sep)) return null;

    const [real, realRoot] = await Promise.all([
      fs.promises.realpath(candidate),
      fs.promises.realpath(CUSTOM_UPLOAD_ROOT)
    ]);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    return real;
  } catch (err) {
    // ENOENT (no existe), EACCES, ERR_INVALID_ARG_VALUE (null bytes), etc.
    // Nunca se propaga el error/stack al caller.
    return null;
  }
}

// --- Capability token de preview del cliente (secciones 13/14, hardening) ---
// Sin tabla/schema nuevo (preferencia explícita del ticket): HMAC-SHA256
// determinista, keyed por UPLOAD_PREVIEW_SECRET -- un secreto DEDICADO,
// nunca SESSION_SECRET -- con un dominio de uso separado
// ("litum3d-custom-upload-preview-v1"), sobre el nombre físico exacto del
// archivo. Propiedades:
//   - alta entropía (256 bits), no adivinable sin conocer UPLOAD_PREVIEW_SECRET;
//   - limitado A ESE archivo exacto: el HMAC de un archivo nunca valida para
//     otro (cross-access imposible sin volver a firmarlo con el secret real);
//   - no requiere persistir nada server-side (nunca hay "hash de token en
//     BD" que gestionar/rotar/purgar: el propio archivo ES el recurso, el
//     token es puramente una función determinista de su nombre + el secret);
//   - sin expiración: vive tanto como el archivo físico. No hay lifecycle de
//     borrado todavía (ver informe, "riesgos pendientes"), así que un token
//     que caducara antes que el archivo rompería el preview sin ninguna
//     ganancia de seguridad real todavía. Rotar UPLOAD_PREVIEW_SECRET SÍ
//     invalida de golpe todos los tokens emitidos hasta entonces.
//
// Secreto DEDICADO (hardening post-review): la versión anterior reutilizaba
// SESSION_SECRET, compartiendo blast radius entre sesiones de Admin y
// capabilities de fotos de clientes -- si una se filtraba/rotaba, afectaba a
// la otra. UPLOAD_PREVIEW_SECRET es una variable de entorno propia:
//   - NUNCA hardcodeada;
//   - SIN fallback a SESSION_SECRET ni a ningún valor fijo;
//   - SIN generación aleatoria en cada arranque (eso invalidaría todos los
//     previews vivos en cada restart/redeploy, y en un entorno con varias
//     instancias cada una firmaría con una key distinta -- inutilizable);
//   - debe fijarse de forma estable en el entorno (.env / secret manager)
//     igual que STRIPE_SECRET_KEY o SESSION_SECRET.
// Si falta: fail-closed total (ver getPreviewSigningSecret). Nunca se
// expone el motivo ni el valor de ningún secreto en logs ni respuestas HTTP.
const PREVIEW_TOKEN_DOMAIN = 'litum3d-custom-upload-preview-v1';

function getPreviewSigningSecret() {
  const secret = process.env.UPLOAD_PREVIEW_SECRET;
  return (typeof secret === 'string' && secret.length > 0) ? secret : null;
}

function isPreviewSecretConfigured() {
  return getPreviewSigningSecret() !== null;
}

// Devuelve null si UPLOAD_PREVIEW_SECRET no está configurado -- todos los
// callers (buildPreviewUrl, verifyPreviewToken) tratan null como
// "no se puede firmar/verificar nada", nunca como "usar un secreto por
// defecto".
function computePreviewToken(filename) {
  const secret = getPreviewSigningSecret();
  if (!secret) return null;
  return crypto.createHmac('sha256', secret)
    .update(`${PREVIEW_TOKEN_DOMAIN}:${filename}`)
    .digest('hex');
}

function verifyPreviewToken(filename, token) {
  if (typeof filename !== 'string' || !isValidCustomUploadFilename(filename)) return false;
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/i.test(token)) return false;
  const expectedHex = computePreviewToken(filename);
  if (!expectedHex) return false; // secreto no configurado -> nunca válido (fail-closed)
  const expected = Buffer.from(expectedHex, 'hex');
  const given = Buffer.from(token, 'hex');
  if (expected.length !== given.length) return false;
  try {
    return crypto.timingSafeEqual(expected, given);
  } catch (err) {
    return false;
  }
}

// Referencia opaca que se guarda en cart/selections/snapshot: ES la URL
// (relativa, misma-origen) que el navegador usa para previsualizar. No hay
// una "key" separada de la "url": es deliberado para no tocar el frontend
// (public/js/cart-page.js ya hace `href="${img.url}"`) ni el contrato de
// services/pricing.js (`images[].url` como string opaco, sin restricción de
// formato). El token va en la query string -- ver informe, sección 14, para
// el análisis de exposición (logs/historial) y por qué se acepta aquí.
// Lanza si el secreto no está configurado: el caller (routes/uploads.js)
// debe comprobar isPreviewSecretConfigured() ANTES de escribir el archivo a
// disco, para no dejar un archivo huérfano sin ninguna forma de referenciarlo.
function buildPreviewUrl(filename) {
  const token = computePreviewToken(filename);
  if (!token) {
    throw new Error('UPLOAD_PREVIEW_SECRET no configurado: no se puede emitir una capability de preview');
  }
  return `/api/uploads/custom/preview/${filename}?t=${token}`;
}

// --- Canonicalización de referencias enviadas por el CLIENTE (hardening) ----
// Usado por services/checkout-payment.js ANTES de fingerprint/pricing/
// snapshot/PaymentIntent (nunca por routes/uploads.js, que sirve el archivo
// una vez el token ya se resolvió).
//
// A diferencia de resolveAdminImageReference (que confía en una sesión de
// Admin YA autenticada y acepta varios formatos históricos), esta función
// NUNCA confía en la palabra del cliente: un string con forma de key interna
// ("custom/x.jpg") o de path legacy ("/uploads/custom/x.jpg") enviado
// DIRECTAMENTE en selections[].images[].url se RECHAZA, aunque tenga forma
// válida -- el cliente debe demostrar posesión de una capability de preview
// realmente emitida por POST /api/uploads/custom (HMAC verificado contra
// UPLOAD_PREVIEW_SECRET). Solo el servidor puede producir la key interna
// final; el cliente nunca puede autoasignarse una.
//
// Pura y determinista (sin tocar el filesystem): solo valida forma + HMAC.
// La existencia real del archivo se comprueba aparte, con
// verifyCustomUploadExists, SOLO cuando corresponde (draft nuevo, sección 9).
const PREVIEW_URL_PATH_PREFIX = '/api/uploads/custom/preview/';

function resolveClientPreviewReference(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return { ok: false, reason: 'invalid' };
  // Cualquier valor con esquema (http:, https:, javascript:, data:, ...) o
  // protocol-relative ("//host/...") se rechaza de plano ANTES de cualquier
  // parseo -- nunca se interpreta como URL externa/absoluta (evita
  // ambigüedades del parser WHATWG URL, que ignora una base relativa cuando
  // el valor de entrada ya es una URL absoluta).
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawUrl) || rawUrl.startsWith('//')) {
    return { ok: false, reason: 'external' };
  }
  if (!rawUrl.startsWith(PREVIEW_URL_PATH_PREFIX)) {
    // Cubre tanto la key interna ("custom/x.jpg") como el path legacy
    // ("/uploads/custom/x.jpg") enviados directamente por el cliente: ambos
    // "tienen forma válida" pero NUNCA se aceptan sin la capability real.
    return { ok: false, reason: 'not_a_preview_url' };
  }
  const afterPrefix = rawUrl.slice(PREVIEW_URL_PATH_PREFIX.length);
  const qIdx = afterPrefix.indexOf('?');
  const filename = qIdx === -1 ? afterPrefix : afterPrefix.slice(0, qIdx);
  const queryString = qIdx === -1 ? '' : afterPrefix.slice(qIdx + 1);
  if (path.basename(filename) !== filename || !isValidCustomUploadFilename(filename)) {
    return { ok: false, reason: 'invalid_filename' };
  }
  const token = new URLSearchParams(queryString).get('t');
  if (!verifyPreviewToken(filename, token)) {
    return { ok: false, reason: 'invalid_token' };
  }
  return { ok: true, filename, canonical: `custom/${filename}` };
}

// Verificación de EXISTENCIA real (toca filesystem): reutiliza
// resolveCustomUploadPath, que ya hace basename+charset+contención de
// raíz+fs.realpath. Se usa SOLO al crear un draft NUEVO (sección 9) -- el
// fast path de retry de un draft ya existente nunca la necesita, porque el
// archivo ya se verificó existente cuando el draft se creó la primera vez.
async function verifyCustomUploadExists(filename) {
  const resolved = await resolveCustomUploadPath(filename);
  return resolved !== null;
}

// --- Referencia persistida en pedidos (sección 19) ---------------------------
// DEFENSIVA / LEGACY tras el hardening de canonicalización: desde que
// services/checkout-payment.js#canonicalizeSelectionsImages resuelve la
// capability URL a "custom/<file>" ANTES de fingerprint/snapshot, un
// snapshot NUEVO ya solo contiene la key interna limpia -- esta función ya
// no necesita "quitar" nada en el camino normal. Se conserva como red de
// seguridad para snapshots creados durante el desarrollo de este mismo
// ticket (antes de la canonicalización) y como no-op inocuo en el resto de
// casos: si recibe algo que YA es la key limpia, la devuelve igual; si
// recibe una capability URL residual (no debería ocurrir en un draft nuevo),
// la reduce igualmente; cualquier otro valor se conserva tal cual.
function extractPersistableImageRuta(rawUrlOrString) {
  if (typeof rawUrlOrString !== 'string' || rawUrlOrString.length === 0) return null;
  const withoutQuery = rawUrlOrString.split('?')[0];
  const basename = path.basename(withoutQuery);
  if (isValidCustomUploadFilename(basename) && (
    withoutQuery === `/api/uploads/custom/preview/${basename}` ||
    withoutQuery === `custom/${basename}`
  )) {
    return `custom/${basename}`;
  }
  return rawUrlOrString;
}

// --- Resolución para Admin (secciones 15/28/29) -------------------------------
// Acepta los formatos que pueden aparecer HOY en detalle_pedido_imagenes.ruta:
//   - nuevo:   "custom/<file>"
//   - legacy:  "/uploads/custom/<file>"  (formato usado antes de este ticket)
// Cualquier valor que parezca una URL externa (http/https) se identifica
// explícitamente como tal y NUNCA se resuelve a un fetch server-side (sección
// 29, SSRF): se devuelve {ok:false, reason:'external'} para que el caller
// responda de forma segura sin intentar descargarlo.
function resolveAdminImageReference(ruta) {
  if (typeof ruta !== 'string' || ruta.length === 0) return { ok: false, reason: 'invalid' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ruta)) {
    // Cualquier esquema con "://" (http, https, ftp...) se trata como
    // referencia externa histórica: no se hace ningún fetch/require de red.
    return { ok: false, reason: 'external' };
  }
  const withoutQuery = ruta.split('?')[0];
  const basename = path.basename(withoutQuery);
  if (!isValidCustomUploadFilename(basename)) return { ok: false, reason: 'invalid' };
  const isNewKey = withoutQuery === `custom/${basename}`;
  const isLegacyPublicPath = withoutQuery === `/uploads/custom/${basename}`;
  if (!isNewKey && !isLegacyPublicPath) return { ok: false, reason: 'invalid' };
  return { ok: true, filename: basename };
}

module.exports = {
  CUSTOM_UPLOAD_ROOT,
  MAX_UPLOAD_FILE_SIZE_BYTES,
  MAX_UPLOAD_FILES,
  detectImageMimeType,
  generateUploadFilename,
  isValidCustomUploadFilename,
  contentTypeForFilename,
  resolveCustomUploadPath,
  isPreviewSecretConfigured,
  computePreviewToken,
  verifyPreviewToken,
  buildPreviewUrl,
  resolveClientPreviewReference,
  verifyCustomUploadExists,
  extractPersistableImageRuta,
  resolveAdminImageReference
};
