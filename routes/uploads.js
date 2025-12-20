const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');

const router = express.Router();

const uploadDir = path.join(__dirname, '..', 'uploads', 'custom');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const base = crypto.randomBytes(8).toString('hex');
    cb(null, `${Date.now()}-${base}${ext}`);
  }
});

const allowedMimes = ['image/jpeg', 'image/png'];

const fileFilter = (req, file, cb) => {
  if (!allowedMimes.includes(file.mimetype)) {
    return cb(new Error('Formato no permitido. Usa JPG o PNG'));
  }
  cb(null, true);
};

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 3 },
  fileFilter
}).array('images', 3);

router.post('/api/uploads/custom', (req, res) => {
  upload(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }

    const files = (req.files || []).map(f => ({
      filename: path.basename(f.filename),
      url: `/uploads/custom/${path.basename(f.filename)}`,
      mimetype: f.mimetype,
      size: f.size
    }));

    res.json({ ok: true, files });
  });
});

module.exports = router;
