/*
  LITUM3D - Retención/borrado de fotografías de personalización vinculadas a
  un pedido (P1 Admin Pedidos/Fotos/Retención).

  Disparado ÚNICAMENTE desde routes/admin.js#PUT /pedidos/:id/estado cuando
  el nuevo estado es exactamente "Entregado" (nombre real de
  estado_pedido, nunca un ID hardcodeado). Ningún otro estado invoca este
  módulo.

  Aislado a propósito de services/uploads-storage.js: ese módulo es la
  PRIMITIVA segura de resolución/acceso (nunca borra nada, solo resuelve
  referencias -> path real o null). Este módulo es la única pieza del
  sistema que emite fs.unlink() reales, y solo sobre imágenes cuya
  pertenencia al pedido solicitado se ha verificado con un JOIN real
  (mismo patrón que routes/admin.js#GET /pedidos/:orderId/imagenes/:imageId).

  Contrato del sentinel DELETED_IMAGE_SENTINEL: significa inequívocamente
  "esta imagen ya no está almacenada por LITUM3D". NUNCA significa
  "intentamos borrarla pero no sabemos si se borró". Por eso:
    - unlink() con éxito              -> se marca DELETED.
    - unlink() con ENOENT (ya no existía, carrera con un borrado previo)
                                       -> operación idempotente, se marca DELETED.
    - unlink() con un error real de filesystem (EACCES/EPERM/EIO/...)
                                       -> la fila NO se toca, conserva su
                                          `ruta` original para poder
                                          reintentarse más tarde.

  Idempotente: reintentar el cleanup del mismo pedido nunca reprocesa filas
  ya DELETED (se saltan sin tocar el filesystem ni la BD) y nunca toca
  imágenes de otro pedido (la pertenencia se revalida en cada llamada vía el
  mismo JOIN, no se asume de una llamada anterior).
*/
const path = require('path');
const fs = require('fs');
const { pool: defaultPool } = require('../config/db');
const uploadsStorage = require('./uploads-storage');

// Único punto de verdad del string mágico: ningún otro archivo debe
// escribir/comparar el literal 'DELETED' directamente -- siempre a través
// de esta constante y de isDeletedImageRuta().
const DELETED_IMAGE_SENTINEL = 'DELETED';

function isDeletedImageRuta(ruta) {
  return ruta === DELETED_IMAGE_SENTINEL;
}

// --- Acceso a datos (inyectable para tests, mismo patrón que services/pricing.js) ---

function defaultDataAccess(pool) {
  return {
    // Mismo JOIN de pertenencia real que routes/admin.js#GET /imagenes/:imageId
    // (dp.pedido_id = ?, no solo "el id de imagen existe"): ninguna imagen de
    // otro pedido puede aparecer aquí.
    async getOwnedImageRows(orderId) {
      const [rows] = await pool.query(
        `SELECT dpi.id, dpi.ruta
         FROM detalle_pedido_imagenes dpi
         JOIN detalle_pedidos dp ON dpi.detalle_pedido_id = dp.id
         WHERE dp.pedido_id = ?`,
        [orderId]
      );
      return rows;
    },
    async markDeleted(imageId) {
      await pool.query(
        'UPDATE detalle_pedido_imagenes SET ruta = ? WHERE id = ?',
        [DELETED_IMAGE_SENTINEL, imageId]
      );
    }
  };
}

function resolveDataAccess(options) {
  return options.dataAccess || defaultDataAccess(options.pool || defaultPool);
}

// Construye el path candidato con la MISMA contención de raíz que
// uploadsStorage.resolveCustomUploadPath (basename ya validado por
// resolveAdminImageReference -- charset acotado, sin "/", sin "..", así que
// un traversal es estructuralmente imposible aquí), pero SIN colapsar
// "no existe" y "error real" al mismo resultado: ese colapso es correcto
// para servir HTTP (nunca ayudar a enumeración), pero incorrecto para un
// cleanup que necesita distinguir ambos casos (ver cabecera del archivo).
// Por eso este módulo llama a fs.unlink() directamente sobre este path en
// vez de reutilizar resolveCustomUploadPath.
//
// Symlinks: a propósito NO se hace fs.realpath() aquí antes de unlink().
// filename ya es un único basename seguro (sin separadores) devuelto por
// resolveAdminImageReference, así que candidate siempre es una entrada
// directa de uploads/custom. fs.unlink() borra esa entrada de directorio
// tal cual -- si es un symlink, borra el symlink, NUNCA el archivo al que
// apunta. Resolver con realpath el último componente antes de unlink
// cambiaría precisamente esa semántica y podría acabar operando sobre el
// target fuera de la raíz, que es justo lo que no queremos tocar.
function resolveCandidatePathForDelete(filename) {
  const candidate = path.join(uploadsStorage.CUSTOM_UPLOAD_ROOT, filename);
  if (!candidate.startsWith(uploadsStorage.CUSTOM_UPLOAD_ROOT + path.sep)) return null;
  return candidate;
}

/**
 * Borra las fotografías privadas de personalización vinculadas
 * EXCLUSIVAMENTE al pedido `orderId`. Idempotente y seguro de reintentar.
 *
 * @param {number|string} orderId
 * @param {object} [options]
 * @param {object} [options.pool] - pool mysql2 alternativo (por defecto, config/db)
 * @param {object} [options.dataAccess] - acceso a datos inyectable (tests)
 * @param {Function} [options.unlink] - fs.promises.unlink inyectable (tests:
 *   simular un error REAL de filesystem -- EACCES/EPERM/EIO -- de forma
 *   determinista y portable no es viable vía chmod real en todas las
 *   plataformas, en particular Windows)
 * @returns {Promise<{attempted:number, deleted:number, alreadyMissing:number, failed:Array<{imageId:number}>}>}
 */
async function deleteOrderCustomerUploads(orderId, options = {}) {
  const dataAccess = resolveDataAccess(options);
  const unlink = options.unlink || fs.promises.unlink;
  const rows = await dataAccess.getOwnedImageRows(orderId);

  const summary = { attempted: 0, deleted: 0, alreadyMissing: 0, failed: [] };

  for (const row of rows) {
    // Ya procesada en un cleanup anterior: nunca se reintenta ni se vuelve
    // a tocar el filesystem para esta fila.
    if (isDeletedImageRuta(row.ruta)) continue;

    summary.attempted++;

    const resolved = uploadsStorage.resolveAdminImageReference(row.ruta);
    if (!resolved.ok) {
      // Referencia legacy/externa/no reconocida (sección 29 P0-FOTOS-01:
      // nunca se hace fetch/unlink de algo que no sea un nombre de archivo
      // propio validado). No podemos afirmar que "ya no está almacenada" --
      // se reporta como fallo para revisión manual, nunca se marca DELETED
      // sin certeza real.
      console.error(`[order-photo-retention] referencia no soportada pedido=${orderId} imagen id=${row.id} reason=${resolved.reason}`);
      summary.failed.push({ imageId: row.id });
      continue;
    }

    const candidatePath = resolveCandidatePathForDelete(resolved.filename);
    if (!candidatePath) {
      console.error(`[order-photo-retention] no se pudo resolver una ruta segura pedido=${orderId} imagen id=${row.id}`);
      summary.failed.push({ imageId: row.id });
      continue;
    }

    try {
      await unlink(candidatePath);
      await dataAccess.markDeleted(row.id);
      summary.deleted++;
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        // Ya no existía (borrado previo que no llegó a actualizar la fila,
        // o carrera con otro proceso): idempotentemente correcto.
        await dataAccess.markDeleted(row.id);
        summary.alreadyMissing++;
      } else {
        // Error real de filesystem (EACCES/EPERM/EIO/...): la fila
        // conserva su `ruta` original para poder reintentarse. Nunca se
        // expone la ruta ni el mensaje crudo fuera de este log.
        console.error(`[order-photo-retention] fallo real al borrar imagen id=${row.id} del pedido ${orderId}: ${(err && err.code) || (err && err.message)}`);
        summary.failed.push({ imageId: row.id });
      }
    }
  }

  return summary;
}

module.exports = {
  DELETED_IMAGE_SENTINEL,
  isDeletedImageRuta,
  deleteOrderCustomerUploads
};
