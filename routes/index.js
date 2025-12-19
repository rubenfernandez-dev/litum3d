const path = require('path');
const express = require('express');

const router = express.Router();

const viewsDir = path.join(__dirname, '..', 'views');

router.get('/', (req, res) => {
  res.sendFile(path.join(viewsDir, 'index.html'));
});

router.get('/about', (req, res) => {
  res.sendFile(path.join(viewsDir, 'about.html'));
});

router.get('/contact', (req, res) => {
  res.sendFile(path.join(viewsDir, 'contact.html'));
});

module.exports = router;
