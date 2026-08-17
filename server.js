require('dotenv').config();
const path = require('path');
const express = require('express');
const morgan = require('morgan');
const session = require('express-session');

const { pool } = require('./config/db');
const { parseTrustProxy } = require('./config/trustProxy');
const { createProductionSessionStore, SESSION_MAX_AGE_MS } = require('./config/sessionStore');
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

// Stripe webhook (P0E-B5): DEBE montarse con el body RAW, ANTES de
// express.json() global -- stripe.webhooks.constructEvent necesita el
// Buffer exacto que Stripe firmó, no un objeto ya parseado (ver
// routes/payments.js#createStripeWebhookRouter). Al responder aquí primero,
// express.json() de abajo nunca llega a tocar esta ruta; el resto de /api
// (paymentsRoutes, montado más abajo) sigue recibiendo JSON normal.
app.use('/api/stripe/webhook', paymentsRoutes.createStripeWebhookRouter());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Trust proxy (P0-SECURITY-01, sección 6): en producción esta app corre
// detrás de Nginx como reverse proxy (ver DEPLOYMENT-GUIDE.md, que configura
// `proxy_set_header X-Forwarded-Proto $scheme;`), una sola instancia PM2 en
// modo fork (ver ecosystem.config.cjs) -- es decir, exactamente UN hop de
// proxy confiable. Sin esto, `cookie.secure` nunca vería la petición como
// HTTPS (Express solo mira req.socket.encrypted, no X-Forwarded-Proto) y
// req.ip usado por el rate limiter de abajo sería siempre la IP de Nginx, no
// la del cliente real. Parsing estricto en config/trustProxy.js (sección 16):
// "false"/"true" nunca se evalúan como truthy/falsy "a la JS".
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY, process.env.NODE_ENV));

// SESSION_SECRET fail-closed (P0-SECURITY-01, secciones 2-3): sin esto NO se
// arranca el servidor. Nunca hay un fallback fijo ('please-configure-...'),
// ni Math.random() (invalidaría todas las sesiones en cada reinicio), ni se
// reutiliza UPLOAD_PREVIEW_SECRET/STRIPE_WEBHOOK_SECRET -- cada secreto tiene
// su función y su variable propia (ver .env.example). El mensaje de error es
// claro pero nunca imprime ningún valor de secreto.
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.error('[server] SESSION_SECRET is required — refusing to start with an insecure session configuration. Set it in .env (see .env.example).');
  process.exit(1);
}

// Same-origin authority fail-closed (cierre final, bloqueante 1): en
// producción, BASE_URL/PUBLIC_BASE_URL debe resolver a una URL absoluta
// válida -- middleware/sameOrigin.js la usa como el origin esperado exacto
// (scheme+host+puerto) para POST /admin/login. Sin un valor válido, NINGUNA
// petición (ni siquiera la legítima) podría demostrar same-origin nunca, así
// que se detecta aquí, en el arranque, en vez de descubrirlo cuando un admin
// real no pueda loguearse.
if (process.env.NODE_ENV === 'production' && !require('./middleware/sameOrigin').computeExpectedOrigin({ allowLocalhostFallback: false })) {
  console.error('[server] BASE_URL o PUBLIC_BASE_URL debe ser una URL absoluta válida en producción (usada como origin esperado para same-origin en /admin/login). Configúrala en .env (ver .env.example).');
  process.exit(1);
}

// Session store (hardening final, secciones 4-10): MySQL persistente en
// producción, NUNCA MemoryStore. Se resuelve de forma async porque el
// arranque en producción verifica primero que la tabla `sessions` (creada
// por database/migrations/add_sessions_table.sql) sea alcanzable -- fail-fast
// ANTES de aceptar tráfico, nunca un fallback silencioso a MemoryStore si
// MySQL no responde (sección 8).
async function buildSessionStore() {
  if (process.env.NODE_ENV !== 'production') {
    // Dev/test: MemoryStore explícito (undefined -> express-session usa su
    // MemoryStore por defecto). No se fuerza MySQL local aquí: un test
    // pequeño o un `npm run dev` sin BD levantada no debe verse bloqueado
    // por esto (sección 8) -- la integración real contra MySQL vive en
    // scripts/check-session-store-mysql.js (opcional, con Docker).
    return undefined;
  }
  try {
    await pool.query('SELECT 1 FROM sessions LIMIT 1');
  } catch (err) {
    console.error('[server] session store MySQL (tabla `sessions`) no disponible -- refusing to start:', err.code || err.message);
    console.error('[server] ejecuta database/migrations/add_sessions_table.sql antes de desplegar (ver DEPLOYMENT-GUIDE.md).');
    process.exit(1);
  }
  return createProductionSessionStore();
}

async function start() {
  const store = await buildSessionStore();

  // Session configuration
  app.use(session({
    store,
    secret: SESSION_SECRET,
    resave: false,
    // false (sección 32): no crear/persistir una sesión para cada visitante
    // anónimo que solo hace GET -- solo se guarda una vez que algo escribe en
    // req.session (login, checkout draft, etc.), evitando hinchar el store
    // con sesiones vacías que nadie usará nunca.
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      // secure:true en producción -- fiable porque trust proxy ya está
      // configurado arriba para leer X-Forwarded-Proto del único hop de Nginx.
      secure: process.env.NODE_ENV === 'production',
      // 'lax' (sección 5): permite que la sesión viaje en navegaciones GET
      // normales (top-level) pero nunca se envía en requests cross-site
      // disparadas por otro origen (formularios/fetch de terceros) -- primera
      // línea de defensa CSRF, complementaria al token de middleware/csrf.js.
      sameSite: 'lax',
      maxAge: SESSION_MAX_AGE_MS // 24 horas: razonable para un panel Admin de un único operador
    }
  }));

  app.use(express.static(path.join(__dirname, 'public')));
  // uploads/custom (fotos de personalización de clientes) NUNCA se sirve como
  // static público (P0-FOTOS-01): no existe ningún otro contenido legítimo
  // bajo uploads/ que necesite estarlo (catálogo/logos viven en public/img,
  // servidos arriba; uploads/temp es staging interno de multer para reseñas,
  // nunca referenciado por URL). El único acceso de lectura es
  // GET /api/uploads/custom/preview/:filename (capability token, cliente) o
  // GET /admin/pedidos/:orderId/imagenes/:imageId (sesión admin) -- ver
  // routes/uploads.js y routes/admin.js.

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
}

start();
