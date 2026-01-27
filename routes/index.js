const path = require('path');
const express = require('express');

const router = express.Router();

const viewsDir = path.join(__dirname, '..', 'views');

router.get('/', (req, res) => {
  res.sendFile(path.join(viewsDir, 'index.html'));
});

router.get('/gallery', (req, res) => {
  res.sendFile(path.join(viewsDir, 'gallery.html'));
});

router.get('/tienda', (req, res) => {
  res.sendFile(path.join(viewsDir, 'shop.html'));
});

router.get('/shop', (req, res) => {
  res.sendFile(path.join(viewsDir, 'shop.html'));
});

router.get('/about', (req, res) => {
  res.sendFile(path.join(viewsDir, 'about.html'));
});

router.get('/contact', (req, res) => {
  res.sendFile(path.join(viewsDir, 'contact.html'));
});

router.get('/cart', (req, res) => {
  res.sendFile(path.join(viewsDir, 'cart.html'));
});

router.get('/checkout', (req, res) => {
  res.sendFile(path.join(viewsDir, 'checkout.html'));
});

router.get('/privacy-policy', (req, res) => {
  res.sendFile(path.join(viewsDir, 'privacy-policy.html'));
});

router.get('/cookies-policy', (req, res) => {
  res.sendFile(path.join(viewsDir, 'cookies-policy.html'));
});

router.get('/terms-conditions', (req, res) => {
  res.sendFile(path.join(viewsDir, 'terms-conditions.html'));
});

router.get('/success', (req, res) => {
  res.sendFile(path.join(viewsDir, 'success.html'));
});

module.exports = router;
