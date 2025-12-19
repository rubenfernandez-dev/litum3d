require('dotenv').config();
const path = require('path');
const express = require('express');
const morgan = require('morgan');

const { pool } = require('./config/db');
const baseRoutes = require('./routes/index');
const contactRoutes = require('./routes/contact');
const usuariosRoutes = require('./routes/usuarios');
const productosRoutes = require('./routes/productos');
const pedidosRoutes = require('./routes/pedidos');
const estadosRoutes = require('./routes/estados');
const paymentsRoutes = require('./routes/payments');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Healthcheck
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'db' });
  }
});

// Routes
app.use(baseRoutes);
app.use(contactRoutes);
app.use(usuariosRoutes);
app.use(productosRoutes);
app.use(pedidosRoutes);
app.use(estadosRoutes);
app.use('/api', paymentsRoutes);

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'views', '404.html'));
});

app.listen(PORT, () => {
  console.log(`LITUM3D server running on http://localhost:${PORT}`);
});
