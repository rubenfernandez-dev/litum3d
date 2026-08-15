// Middleware canónico de autenticación de admin (req.session.adminId).
// Único punto de verdad para proteger mutaciones administrativas: routes/admin.js,
// routes/productos.js y routes/variantes.js lo importan desde aquí en vez de
// depender unas de otras solo para reutilizar este middleware.
const requireAuth = (req, res, next) => {
  console.log('🔐 Auth check:', {
    hasSession: !!req.session,
    sessionId: req.sessionID,
    adminId: req.session?.adminId,
    cookies: req.headers.cookie
  });
  if (!req.session || !req.session.adminId) {
    console.log('❌ Auth failed: No session or adminId');
    return res.status(401).json({ error: 'No autorizado' });
  }
  console.log('✓ Auth passed for admin', req.session.adminId);
  next();
};

module.exports = requireAuth;
