/*
  LITUM3D - Upload y preview privado de fotografías personalizadas (P0-FOTOS-01).

  POST /api/uploads/custom  - sube hasta 3 imágenes (público/anónimo: el
    cliente puede personalizar antes de tener cuenta). Nunca escribe a disco
    hasta validar magic bytes reales; el nombre físico es siempre
    crypto.randomUUID(), nunca originalname/timestamp.

  GET /api/uploads/custom/preview/:filename - sirve una imagen ya subida,
    protegida por un capability token (?t=) determinista por archivo (ver
    services/uploads-storage.js). Es el ÚNICO acceso público a estas fotos:
    NO existe ningún express.static sirviendo uploads/custom (ver server.js).

  El acceso ADMIN (autenticado por sesión, vinculado a un pedido) vive en
  routes/admin.js y reutiliza los mismos helpers de services/uploads-storage.js,
  pero es un canal completamente independiente del capability token de aquí.
*/
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const uploadsStorage = require('../services/uploads-storage');

const router = express.Router();

if (!fs.existsSync(uploadsStorage.CUSTOM_UPLOAD_ROOT)) {
  fs.mkdirSync(uploadsStorage.CUSTOM_UPLOAD_ROOT, { recursive: true });
}

// memoryStorage (no diskStorage): necesitamos el Buffer completo en memoria
// ANTES de decidir el nombre/tipo real (magic bytes) y ANTES de escribir
// nada a disco -- así ningún archivo llega al filesystem sin haber sido
// validado por su contenido real, no por lo que declara el cliente.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploadsStorage.MAX_UPLOAD_FILE_SIZE_BYTES, files: uploadsStorage.MAX_UPLOAD_FILES },
  fileFilter: (req, file, cb) => {
    // Primer filtro barato (mimetype declarado por el navegador): rechaza
    // rápido lo obviamente no permitido. NO es la autoridad real -- eso es
    // detectImageMimeType() sobre el buffer, más abajo, tras el upload.
    if (file.mimetype !== 'image/jpeg' && file.mimetype !== 'image/png') {
      return cb(new Error('Formato no permitido. Usa JPG o PNG'));
    }
    cb(null, true);
  }
}).array('images', uploadsStorage.MAX_UPLOAD_FILES);

router.post('/api/uploads/custom', (req, res) => {
  upload(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }

    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ ok: false, error: 'No se recibió ninguna imagen' });
    }

    // Validación real de contenido (magic bytes) ANTES de escribir nada a
    // disco: si CUALQUIER archivo del lote no es un JPEG/PNG genuino, se
    // rechaza el lote completo (nunca una escritura parcial silenciosa).
    const detected = files.map(file => ({ file, mimeType: uploadsStorage.detectImageMimeType(file.buffer) }));
    const invalid = detected.find(d => !d.mimeType);
    if (invalid) {
      return res.status(400).json({ ok: false, error: 'Uno de los archivos no es una imagen JPG/PNG válida' });
    }

    // Fail-closed (hardening post-review): sin UPLOAD_PREVIEW_SECRET no se
    // puede emitir ninguna capability válida -- se rechaza ANTES de escribir
    // nada a disco, para no dejar archivos huérfanos sin ninguna forma
    // (segura) de referenciarlos. Mensaje genérico: nunca se expone al
    // cliente que el motivo es un secreto de configuración ausente.
    if (!uploadsStorage.isPreviewSecretConfigured()) {
      console.error('[routes/uploads] UPLOAD_PREVIEW_SECRET no configurado -- rechazando upload de forma segura');
      return res.status(500).json({ ok: false, error: 'No se pudo procesar la imagen. Inténtalo de nuevo más tarde.' });
    }

    try {
      const results = [];
      for (const { file, mimeType } of detected) {
        const filename = uploadsStorage.generateUploadFilename(mimeType);
        const destPath = path.join(uploadsStorage.CUSTOM_UPLOAD_ROOT, filename);
        await fs.promises.writeFile(destPath, file.buffer);
        results.push({
          filename,
          url: uploadsStorage.buildPreviewUrl(filename),
          mimetype: mimeType,
          size: file.size
        });
      }
      res.json({ ok: true, files: results });
    } catch (writeErr) {
      console.error('[routes/uploads] error escribiendo archivo subido:', writeErr.message);
      res.status(500).json({ ok: false, error: 'No se pudo guardar la imagen' });
    }
  });
});

// GET /api/uploads/custom/preview/:filename?t=<token>
// Único punto de lectura pública de estas fotos. Sin token válido -> 404
// genérico (nunca distingue "no existe" de "token incorrecto", sección 30).
router.get('/api/uploads/custom/preview/:filename', async (req, res) => {
  const { filename } = req.params;
  const token = req.query.t;

  if (!uploadsStorage.verifyPreviewToken(filename, token)) {
    return res.status(404).end();
  }

  const resolvedPath = await uploadsStorage.resolveCustomUploadPath(filename);
  if (!resolvedPath) {
    return res.status(404).end();
  }

  const contentType = uploadsStorage.contentTypeForFilename(filename);
  if (!contentType) {
    return res.status(404).end();
  }

  res.set({
    'Content-Type': contentType,
    'Content-Disposition': 'inline',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff'
  });

  // resolvedPath ya es un path ABSOLUTO validado por resolveCustomUploadPath
  // (basename + charset + contención de raíz + fs.realpath): no se pasa
  // {root} aquí -- Express/`send` rechaza combinar un path absoluto con la
  // opción root ("Rooted path is not allowed"). La contención de raíz ya
  // quedó garantizada antes de llegar aquí.
  res.sendFile(resolvedPath, (err) => {
    if (err && !res.headersSent) {
      res.status(404).end();
    }
  });
});

module.exports = router;
