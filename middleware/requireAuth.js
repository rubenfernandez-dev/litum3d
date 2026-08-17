// Middleware canónico de autenticación de admin (req.session.adminId).
// Único punto de verdad para proteger mutaciones administrativas: routes/admin.js,
// routes/productos.js y routes/variantes.js lo importan desde aquí en vez de
// depender unas de otras solo para reutilizar este middleware.
const requireAuth = (req, res, next) => {
  // Nunca loguear cookies/sessionID/tokens aquí (sección 41): esto se
  // ejecuta en TODAS las mutaciones administrativas, así que cualquier log
  // verboso aquí sería el sitio más fácil para filtrar una sesión completa.
  if (!req.session || !req.session.adminId) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
};

module.exports = requireAuth;
