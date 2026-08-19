// Hardening de cabeceras HTTP de seguridad (auditoría "headers de seguridad
// MUY controlado"). Todo lo de aquí se aplica desde Express porque
// controlamos el proceso Node directamente; Nginx (reverse proxy delante,
// ver DEPLOYMENT-GUIDE.md) no se toca en esta tarea -- no hay ningún
// nginx.conf versionado en el repo que sea "fuente de verdad" editable, y
// la config real del VPS está fuera del alcance de este cambio.
//
// Objetivo explícito: nada de esto puede romper Stripe (checkout), las
// imágenes de Cloudinary, Google Fonts, el banner de cookies, ni el panel
// Admin. Cada allowlist de abajo viene de un inventario real de recursos
// externos (grep sobre views/ y public/js/), nunca de una plantilla
// genérica copiada.

// Inventario verificado de recursos externos reales (ver informe de la
// tarea para el detalle completo):
// - https://js.stripe.com        : <script src> en checkout.html/-de/-fr,
//                                   y el iframe que Stripe Elements inyecta.
// - https://hooks.stripe.com     : iframe de verificación 3D Secure que
//                                   Stripe.js puede abrir durante el pago.
// - https://api.stripe.com       : llamadas XHR que hace stripe.js v3 desde
//                                   dentro de la página (tokenización, etc.)
//                                   -- requisito documentado por Stripe.
// - https://fonts.googleapis.com : @import en public/css/styles.css (Noto
//                                   Color Emoji).
// - https://fonts.gstatic.com    : origen real del fichero de fuente que
//                                   sirve ese @import.
// - https://res.cloudinary.com   : todas las imágenes de producto/galería
//                                   (views/*.html y public/js/gallery.js).
// - https://www.googletagmanager.com : cargado dinámicamente por
//                                   public/js/cookie-banner.js#loadAnalytics
//                                   SOLO si el usuario acepta cookies de
//                                   análisis -- código vivo y alcanzable
//                                   aunque hoy use un GA_ID placeholder, así
//                                   que se incluye para no romper ese flujo
//                                   el día que se configure un ID real.
// - https://www.google-analytics.com / https://analytics.google.com :
//                                   destino de los beacons que ese mismo
//                                   gtag.js enviaría (connect-src/img-src).
//
// wa.me (WhatsApp) NO necesita entrar aquí: son enlaces <a href> de
// navegación saliente normales, CSP no restringe eso.
const CSP_DIRECTIVES = {
  'default-src': ["'self'"],
  // 'unsafe-inline' es una concesión deliberada, no un descuido: LITUM3D
  // tiene cientos de atributos style="" inline y varios <script> inline
  // (JSON-LD, contador del carrito, handlers onclick=) repartidos por las
  // 36 páginas públicas. Añadir nonces/hashes a todo eso es un cambio
  // estructural grande que esta tarea NO cubre ("no implementes nonces/
  // hashes masivos salvo que ya exista infraestructura" -- no existe). Por
  // eso la política se despliega en Report-Only: documenta la política
  // objetivo real sin arriesgarse a romper checkout/Admin con una directiva
  // que en la práctica no se puede cumplir todavía.
  'script-src': ["'self'", "'unsafe-inline'", 'https://js.stripe.com', 'https://www.googletagmanager.com'],
  'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  'font-src': ["'self'", 'https://fonts.gstatic.com'],
  'img-src': ["'self'", 'https://res.cloudinary.com', 'https://www.google-analytics.com'],
  'connect-src': ["'self'", 'https://api.stripe.com', 'https://www.google-analytics.com', 'https://analytics.google.com'],
  'frame-src': ['https://js.stripe.com', 'https://hooks.stripe.com'],
  // Nadie más debe poder enmarcar litum3d.com (protección real la da el
  // header X-Frame-Options: DENY, más abajo -- esto es la señal CSP3
  // equivalente, documentada aquí aunque en Report-Only no bloquee todavía).
  'frame-ancestors': ["'none'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  // Todos los <form> de la app son same-origin (auditado: ningún
  // action="https://..." externo en views/).
  'form-action': ["'self'"]
};

function buildCspHeaderValue(directives) {
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}

const CSP_REPORT_ONLY_VALUE = buildCspHeaderValue(CSP_DIRECTIVES);

// Permissions-Policy: solo se restringen explícitamente las capacidades que
// NO se usan en ningún sitio del código (auditado: sin getUserMedia, sin
// navigator.geolocation, sin requestFullscreen, sin PaymentRequest directo).
// "payment" se deja disponible para 'self' y para el iframe de Stripe
// Elements (checkout.html usa Payment Element con paypal/twint/amazon_pay/
// card en paymentMethodOrder, que puede necesitar delegar esta capacidad
// para mostrar botones de wallet) -- deshabilitarla podría ocultar
// silenciosamente métodos de pago sin que checkout "rompa" de forma visible.
const PERMISSIONS_POLICY_VALUE = [
  'camera=()',
  'microphone=()',
  'geolocation=()',
  'usb=()',
  'magnetometer=()',
  'gyroscope=()',
  'interest-cohort=()',
  'payment=(self "https://js.stripe.com")'
].join(', ');

const HSTS_MAX_AGE_SECONDS = 15552000; // 180 días: conservador a propósito (sección 11: nada de preload/includeSubDomains sin verificación adicional).

function securityHeaders(req, res, next) {
  // X-Content-Type-Options (sección 8): sin condiciones, siempre seguro.
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Referrer-Policy (sección 9): conserva el origin completo en navegación
  // same-origin, solo el origin (sin path/query) cross-origin sobre HTTPS,
  // y nada en un downgrade HTTPS->HTTP. No interfiere con Stripe (no
  // depende de nuestro Referer) ni con GA/GTM si se activan.
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Clickjacking (sección 7): litum3d.com no necesita ser embebido por
  // nadie -- los iframes de Stripe son AL REVÉS (Stripe embebido dentro de
  // nosotros), eso no depende de que a NOSOTROS nos puedan enmarcar.
  // X-Frame-Options es el header que de verdad bloquea el framing hoy
  // (frame-ancestors vive en la CSP, que está en Report-Only más abajo).
  res.setHeader('X-Frame-Options', 'DENY');

  // Permissions-Policy (sección 10).
  res.setHeader('Permissions-Policy', PERMISSIONS_POLICY_VALUE);

  // CSP en Report-Only (sección 6): ver razonamiento completo arriba y en
  // el informe de la tarea. Se aplica en TODA respuesta (incluye Admin/API)
  // para que la política se pueda validar con tráfico real de todas las
  // superficies antes de decidir activarla en modo enforced.
  res.setHeader('Content-Security-Policy-Report-Only', CSP_REPORT_ONLY_VALUE);

  // HSTS (sección 11): solo si esta petición concreta llegó por HTTPS de
  // verdad. req.secure ya resuelve X-Forwarded-Proto correctamente porque
  // `trust proxy` está configurado en server.js para el único hop de Nginx
  // (ver comentario ahí) -- en dev/local (HTTP) req.secure es false y este
  // header nunca se envía, evitando además depender de que el navegador
  // ignore el header si llegase por HTTP sin cifrar.
  if (req.secure && process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', `max-age=${HSTS_MAX_AGE_SECONDS}`);
  }

  next();
}

module.exports = { securityHeaders, CSP_DIRECTIVES, CSP_REPORT_ONLY_VALUE, PERMISSIONS_POLICY_VALUE, HSTS_MAX_AGE_SECONDS };
