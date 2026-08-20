/*
  LITUM3D - Capa visual única para emails transaccionales (saneamiento del
  sistema de emails).

  Antes de este módulo, cada ruta (routes/payments.js, routes/admin.js)
  construía su propio HTML de email desde cero, con estilos y estructura
  distintos entre sí (routes/payments.js ya usaba el fondo oscuro/dorado real
  de LITUM3D; routes/admin.js usaba un degradado azul/morado genérico sin
  relación con la identidad visual del sitio). Este archivo es la ÚNICA
  fuente de la estructura de header/footer/soporte y de los colores de marca
  para CUALQUIER email que envíe la aplicación.

  Diseño: tablas + estilos inline (compatibilidad Gmail/Outlook/Apple Mail),
  sin JS, sin CSS externo, sin Google Fonts, ancho máximo ~600px. El logo se
  sirve siempre con una URL HTTPS absoluta (los clientes de correo no cargan
  rutas relativas); ver getLogoUrl().

  API principal: renderLitumEmail({ locale, preheader, title, contentHtml,
  contentText, orderId, showSupport }) -> { html, text }.
*/
const { normalizeLocale } = require('../config/locales');

// --- Marca ------------------------------------------------------------------

const BRAND = {
  primary: '#1a1a2e', // fondo oscuro real del sitio (public/css/styles.css --primary)
  primaryDarker: '#0f172a',
  panel: '#111827',
  gold: '#e0ad61', // dorado real del sitio (public/css/styles.css --gold)
  goldLight: '#f0c070',
  textLight: '#e5e7eb',
  textMuted: '#b6c2d9',
  fontFamily: "'Segoe UI', Arial, Helvetica, sans-serif" // fallbacks reales, sin Google Fonts
};

// Datos públicos reales de soporte de LITUM3D (mismos que en el footer de
// views/*.html -- ver p.ej. views/checkout.html, views/success.html).
const SUPPORT_INFO = {
  email: 'contact@litum3d.com',
  phone: '+41 77 218 62 29',
  phoneHref: '+41772186229'
};

function getBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || 'https://litum3d.com').replace(/\/$/, '');
}

// El logo de un email SIEMPRE necesita una URL HTTPS absoluta (los clientes
// de correo no resuelven "/img/..." contra ningún host): se reutiliza el
// logo real ya servido en el header público del sitio (views/*.html),
// nunca uno inventado. LOGO_URL permite sobreescribirlo si algún día se aloja
// en un CDN de emails dedicado (p.ej. para mejorar la entregabilidad).
function getLogoUrl() {
  return process.env.LOGO_URL || `${getBaseUrl()}/img/logos/lineal.logo.png`;
}

// Rutas legales reales por idioma (ver routes/index.js / views/terms-conditions*.html).
const LEGAL_PATHS = {
  es: { privacy: '/privacy-policy', terms: '/terms-conditions', contact: '/contact' },
  de: { privacy: '/privacy-policy-de', terms: '/terms-conditions-de', contact: '/contact-de' },
  fr: { privacy: '/privacy-policy-fr', terms: '/terms-conditions-fr', contact: '/contact-fr' }
};

// Copys del footer, idénticos a los ya usados en views/success*.html.
const FOOTER_COPY = {
  es: { tagline: 'Premium 3D Litofanías', privacy: 'Política de Privacidad', terms: 'Términos de Servicio', contact: 'Contacto', copyright: (y) => `© ${y} LITUM3D. Todos los derechos reservados.` },
  de: { tagline: 'Premium 3D-Lithophane', privacy: 'Datenschutz', terms: 'Nutzungsbedingungen', contact: 'Kontakt', copyright: (y) => `© ${y} LITUM3D. Alle Rechte vorbehalten.` },
  fr: { tagline: 'Lithophanies 3D premium', privacy: 'Politique de confidentialité', terms: 'Conditions d’utilisation', contact: 'Contact', copyright: (y) => `© ${y} LITUM3D. Tous droits réservés.` }
};

const SUPPORT_BLOCK_COPY = {
  es: {
    title: '¿Necesitas ayuda con este pedido?',
    body: (ref) => `Si necesitas ayuda, tienes alguna incidencia o deseas realizar una consulta o reclamación sobre este pedido, responde directamente a este correo indicando la referencia #${ref}.`
  },
  de: {
    title: 'Brauchst du Hilfe zu dieser Bestellung?',
    body: (ref) => `Wenn du Hilfe brauchst, ein Problem hast oder eine Frage bzw. Reklamation zu dieser Bestellung hast, antworte einfach direkt auf diese E-Mail und gib die Referenz #${ref} an.`
  },
  fr: {
    title: 'Besoin d’aide concernant cette commande ?',
    body: (ref) => `Si vous avez besoin d’aide, rencontrez un problème ou souhaitez poser une question ou une réclamation concernant cette commande, répondez directement à cet e-mail en indiquant la référence #${ref}.`
  }
};

// Reexportado desde config/locales.js (normalizador central, ver
// config/locales.js#normalizeLocale): antes este archivo tenía su propia
// copia local (LEGAL_PATHS[locale] ? locale : 'es'), y services/order-emails.js
// otra distinta -- ambas coincidían en los mismos 3 idiomas, así que ahora
// hay una única fuente de verdad.

// --- Escape HTML compartido --------------------------------------------------
// Único helper autorizado para escapar datos dinámicos (nombre, email,
// teléfono, dirección, notas, nombres de producto/variante...) antes de
// interpolarlos en HTML de email. Reutilizado por routes/payments.js,
// routes/admin.js y routes/contact.js -- antes cada archivo tenía su propia
// copia (o, en admin.js/contact.js, ninguna).
function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(text == null ? '' : text).replace(/[&<>"']/g, (m) => map[m]);
}

// --- Bloque de soporte --------------------------------------------------------

function renderSupportBlockHtml(locale, orderId) {
  const copy = SUPPORT_BLOCK_COPY[normalizeLocale(locale)];
  return `
    <div style="margin-top:22px; padding:16px 18px; background:rgba(224,173,97,0.08); border:1px solid rgba(224,173,97,0.35); border-radius:12px;">
      <div style="font-weight:700; color:${BRAND.goldLight}; font-size:14px; margin-bottom:6px;">${escapeHtml(copy.title)}</div>
      <p style="margin:0 0 10px 0; color:${BRAND.textMuted}; font-size:13px; line-height:1.6;">${escapeHtml(copy.body(orderId))}</p>
      <p style="margin:0; color:${BRAND.textLight}; font-size:13px; line-height:1.6;">
        ${escapeHtml(SUPPORT_INFO.email)}<br>
        ${escapeHtml(SUPPORT_INFO.phone)}
      </p>
    </div>
  `;
}

function renderSupportBlockText(locale, orderId) {
  const copy = SUPPORT_BLOCK_COPY[normalizeLocale(locale)];
  return [
    copy.title,
    copy.body(orderId),
    `${SUPPORT_INFO.email} · ${SUPPORT_INFO.phone}`
  ].join('\n');
}

// --- Footer -------------------------------------------------------------------

function renderFooterHtml(locale) {
  const loc = normalizeLocale(locale);
  const paths = LEGAL_PATHS[loc];
  const copy = FOOTER_COPY[loc];
  const baseUrl = getBaseUrl();
  const year = new Date().getFullYear();
  return `
    <div style="padding:20px 24px; border-top:1px solid rgba(255,255,255,0.08); text-align:center;">
      <div style="font-weight:700; color:${BRAND.textLight}; font-size:13px;">LITUM3D</div>
      <div style="color:${BRAND.textMuted}; font-size:12px; margin-top:2px;">${escapeHtml(copy.tagline)}</div>
      <div style="margin-top:10px; font-size:12px;">
        <a href="${baseUrl}${paths.privacy}" style="color:${BRAND.gold}; text-decoration:none;">${escapeHtml(copy.privacy)}</a>
        <span style="color:${BRAND.textMuted};"> · </span>
        <a href="${baseUrl}${paths.terms}" style="color:${BRAND.gold}; text-decoration:none;">${escapeHtml(copy.terms)}</a>
        <span style="color:${BRAND.textMuted};"> · </span>
        <a href="${baseUrl}${paths.contact}" style="color:${BRAND.gold}; text-decoration:none;">${escapeHtml(copy.contact)}</a>
      </div>
      <div style="color:${BRAND.textMuted}; font-size:11px; margin-top:10px;">${escapeHtml(copy.copyright(year))}</div>
    </div>
  `;
}

function renderFooterText(locale) {
  const loc = normalizeLocale(locale);
  const paths = LEGAL_PATHS[loc];
  const copy = FOOTER_COPY[loc];
  const baseUrl = getBaseUrl();
  const year = new Date().getFullYear();
  return [
    'LITUM3D',
    `${copy.privacy}: ${baseUrl}${paths.privacy}`,
    `${copy.terms}: ${baseUrl}${paths.terms}`,
    `${copy.contact}: ${baseUrl}${paths.contact}`,
    copy.copyright(year)
  ].join('\n');
}

// --- Layout principal ---------------------------------------------------------

/**
 * Envuelve contentHtml/contentText con header (logo real), bloque de soporte
 * (opcional, cuando hay orderId) y footer (enlaces legales absolutos). No
 * recalcula ni muestra ningún importe: los totales/IVA los decide siempre
 * el llamante (ver services/order-emails.js) a partir del snapshot real.
 *
 * @param {object} opts
 * @param {string} [opts.locale='es'] - 'es'|'de'|'fr', cae a 'es' si no se reconoce.
 * @param {string} [opts.preheader] - texto oculto de precarga (inbox preview).
 * @param {string} opts.title - título visible en el header, junto al logo.
 * @param {string} opts.contentHtml - HTML específico de este email (ya escapado por el llamante).
 * @param {string} opts.contentText - versión texto del mismo contenido.
 * @param {number|string} [opts.orderId] - si se indica, se muestra el bloque de soporte con la referencia.
 * @param {boolean} [opts.showSupport=true] - permite omitir el bloque de soporte (p.ej. email interno a Admin).
 * @returns {{html: string, text: string}}
 */
function renderLitumEmail({ locale = 'es', preheader = '', title, contentHtml, contentText, orderId = null, showSupport = true }) {
  const loc = normalizeLocale(locale);
  const logoUrl = getLogoUrl();

  const supportHtml = (showSupport && orderId != null) ? renderSupportBlockHtml(loc, orderId) : '';
  const supportText = (showSupport && orderId != null) ? `\n\n${renderSupportBlockText(loc, orderId)}` : '';

  const html = `
    <div style="background:${BRAND.primaryDarker}; padding:32px 16px; font-family:${BRAND.fontFamily}; color:${BRAND.textLight};">
      ${preheader ? `<div style="display:none; max-height:0; overflow:hidden; opacity:0;">${escapeHtml(preheader)}</div>` : ''}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px; margin:0 auto; background:${BRAND.panel}; border:1px solid rgba(255,255,255,0.08); border-radius:16px; overflow:hidden;">
        <tr>
          <td style="background:linear-gradient(135deg,${BRAND.primaryDarker},${BRAND.primary}); padding:18px 24px;">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td style="background:#ffffff; padding:6px 10px; border-radius:10px;">
                  <img src="${logoUrl}" alt="LITUM3D" height="32" style="height:32px; width:auto; display:block; border:0;" />
                </td>
                <td style="padding-left:14px; font-size:16px; font-weight:700; color:#ffffff;">${escapeHtml(title || 'LITUM3D')}</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:24px; line-height:1.6; font-size:14px;">
            ${contentHtml}
            ${supportHtml}
          </td>
        </tr>
        <tr>
          <td>${renderFooterHtml(loc)}</td>
        </tr>
      </table>
    </div>
  `;

  const text = [
    (title || 'LITUM3D').toUpperCase(),
    '',
    contentText,
    supportText,
    '',
    '---',
    renderFooterText(loc)
  ].filter((line) => line !== '').join('\n');

  return { html, text };
}

module.exports = {
  BRAND,
  SUPPORT_INFO,
  LEGAL_PATHS,
  getBaseUrl,
  getLogoUrl,
  escapeHtml,
  renderLitumEmail,
  normalizeLocale
};
