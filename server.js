require('dotenv').config();
const path = require('path');
const express = require('express');
const morgan = require('morgan');
const session = require('express-session');

const { pool } = require('./config/db');
const baseRoutes = require('./routes/index');
const contactRoutes = require('./routes/contact');
const usuariosRoutes = require('./routes/usuarios');
const productosRoutes = require('./routes/productos');
const variantesRoutes = require('./routes/variantes');
const pedidosRoutes = require('./routes/pedidos');
const estadosRoutes = require('./routes/estados');
const paymentsRoutes = require('./routes/payments');
const adminRoutes = require('./routes/admin');
const uploadsRoutes = require('./routes/uploads');
const reviewsRoutes = require('./routes/reviews');
const seoRoutes = require('./routes/seo');
const seoMiddleware = require('./config/seo-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'please-configure-session-secret-in-production',
  resave: false,
  saveUninitialized: true,
  cookie: { 
    secure: process.env.NODE_ENV === 'production', // Set to true for HTTPS in production
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// SEO Middleware
app.use(seoMiddleware);

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
app.use(variantesRoutes);
app.use(pedidosRoutes);
app.use(estadosRoutes);
app.use('/api', paymentsRoutes);
app.use(uploadsRoutes);
app.use(reviewsRoutes);
app.use(seoRoutes);
app.use('/admin', adminRoutes);

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'views', '404.html'));
});

app.listen(PORT, () => {
  console.log(`LITUM3D server running on http://localhost:${PORT}`);
});
