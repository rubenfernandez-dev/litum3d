/*
  LITUM3D - Constructores de los 3 emails relacionados con pedidos
  (confirmación al cliente, nuevo pedido a Admin, cambio de estado),
  todos sobre la capa visual única de services/email-template.js.

  NUNCA recalcula ni desglosa importes: usa exactamente totals.totalCents /
  totals.shippingCents que ya calculó services/pricing.js (VAT_PERCENT=0,
  ver informe de saneamiento fiscal). Sin desglose fiscal de ningún tipo.

  Locale (informe "persistir locale del comprador" + "añadir locale EN"):
  document.documentElement.lang (public/js/checkout.js) se normaliza a
  es/de/fr/en y viaja como
  customerData.locale -> PATCH /api/checkout-draft/customer-data ->
  services/checkout-drafts.js#validateCustomerData (normalizado con
  config/locales.js#normalizeLocale) -> snapshot_json persistido en
  checkout_drafts. routes/payments.js lee snapshot.customerData.locale para
  la confirmación inmediata; routes/admin.js lo recupera más tarde (cambio
  de estado, días después) vía checkoutDrafts.getDraftByPaymentIntentId()
  uniendo pedidos.stripe_payment_intent_id <-> checkout_drafts (la fila del
  draft nunca se borra, solo cambia de status). El país de envío NUNCA es
  un proxy del idioma (CH es DE/FR/IT; un FR puede comprar estando en CH):
  el locale siempre viene del valor explícito normalizado, nunca inferido
  de customerData.country. Pedidos/drafts anteriores a este cambio no
  tienen customerData.locale -- normalizeLocale(undefined) cae a 'es'.
*/
const {
  escapeHtml,
  renderLitumEmail,
  getBaseUrl,
  SUPPORT_INFO
} = require('./email-template');
const { normalizeLocale } = require('../config/locales');

// --- Utilidades de formato ---------------------------------------------------

// Formato europeo (coma decimal, símbolo detrás): "49,95 €". EUR-only
// (config/pricing.js#currency); si algún día currency no fuera 'eur', se
// muestra el código ISO en su lugar, nunca un símbolo inventado.
function formatMoney(cents, currency) {
  const amount = (Number(cents) || 0) / 100;
  const formatted = amount.toFixed(2).replace('.', ',');
  return currency === 'eur' ? `${formatted} €` : `${formatted} ${String(currency).toUpperCase()}`;
}

const DATE_FORMAT_LOCALES = { es: 'es-ES', de: 'de-CH', fr: 'fr-CH', en: 'en-GB' };
function formatDate(date, locale) {
  try {
    return new Intl.DateTimeFormat(DATE_FORMAT_LOCALES[locale] || DATE_FORMAT_LOCALES.es, {
      year: 'numeric', month: 'long', day: 'numeric'
    }).format(date);
  } catch (e) {
    return date.toISOString().slice(0, 10);
  }
}

// "Base: Madera", "Forma: Cilíndrica"... -- mismos nombres que ya usa el
// motor de pricing (services/pricing.js#variantSelections), nunca inventados.
function describeVariants(variantSelections) {
  return (variantSelections || []).map((v) => `${v.variantTypeName}: ${v.optionName}`);
}

// Mismas etiquetas que ya muestra public/js/checkout.js#renderOrderSummaryFromBreakdown.
function describeExtras(extras, qrLabel) {
  const parts = [];
  if (extras?.upscale) parts.push('Upscale');
  if (extras?.qr) parts.push(extras.qrMessage ? `QR: ${extras.qrMessage}` : 'QR');
  if (extras?.adapter) parts.push(qrLabel);
  return parts;
}

// --- Copys por idioma ---------------------------------------------------------

const COPY = {
  es: {
    confirmationSubject: (orderId) => `[LITUM3D #${orderId}] Confirmación de pedido`,
    confirmationTitle: 'Pedido confirmado',
    confirmationPreheader: (orderId) => `Hemos recibido tu pedido #${orderId}. Gracias por confiar en LITUM3D.`,
    greeting: (name) => `Hola ${name},`,
    intro: 'Gracias por tu compra en LITUM3D. Estamos preparando tu pedido.',
    orderNumberLabel: 'Número de pedido',
    dateLabel: 'Fecha',
    shippingAddressLabel: 'Datos de envío',
    phoneLabel: 'Teléfono',
    tableHeaders: { product: 'Producto', qty: 'Cant.', price: 'Precio', subtotal: 'Subtotal' },
    shippingLabel: 'Envío',
    freeShipping: 'Gratis',
    totalLabel: 'TOTAL',
    ctaText: 'Ir a LITUM3D',
    adapterLabel: 'Adaptador USB',
    statusSubject: (orderId) => `[LITUM3D #${orderId}] Actualización de tu pedido`,
    statusTitle: 'Actualización de tu pedido',
    statusPreheader: (orderId) => `Hay novedades sobre tu pedido #${orderId}.`,
    statusIntro: (name) => `Hola ${name || 'cliente'},`,
    statusMessages: {
      'Pendiente': 'Tu pedido está en espera de confirmación.',
      'Confirmado': 'Tu pedido ha sido confirmado y comenzaremos a prepararlo.',
      'Preparando': 'Tu pedido está siendo preparado en nuestros talleres.',
      'Enviado': 'Tu pedido ha sido enviado y está en camino.',
      'Entregado': 'Tu pedido ha sido entregado. ¡Gracias por tu compra!',
      'Cancelado': 'Tu pedido ha sido cancelado.'
    },
    statusFallback: 'Tu pedido ha sido actualizado.'
  },
  de: {
    confirmationSubject: (orderId) => `[LITUM3D #${orderId}] Bestellbestätigung`,
    confirmationTitle: 'Bestellung bestätigt',
    confirmationPreheader: (orderId) => `Wir haben deine Bestellung #${orderId} erhalten. Danke, dass du LITUM3D vertraust.`,
    greeting: (name) => `Hallo ${name},`,
    intro: 'Danke für deinen Einkauf bei LITUM3D. Wir bereiten deine Bestellung vor.',
    orderNumberLabel: 'Bestellnummer',
    dateLabel: 'Datum',
    shippingAddressLabel: 'Lieferadresse',
    phoneLabel: 'Telefon',
    tableHeaders: { product: 'Produkt', qty: 'Menge', price: 'Preis', subtotal: 'Zwischensumme' },
    shippingLabel: 'Versand',
    freeShipping: 'Kostenlos',
    totalLabel: 'GESAMT',
    ctaText: 'Zu LITUM3D',
    adapterLabel: 'USB-Adapter',
    statusSubject: (orderId) => `[LITUM3D #${orderId}] Aktualisierung deiner Bestellung`,
    statusTitle: 'Aktualisierung deiner Bestellung',
    statusPreheader: (orderId) => `Es gibt Neuigkeiten zu deiner Bestellung #${orderId}.`,
    statusIntro: (name) => `Hallo ${name || 'Kunde'},`,
    statusMessages: {
      'Pendiente': 'Deine Bestellung wartet auf Bestätigung.',
      'Confirmado': 'Deine Bestellung wurde bestätigt und wir beginnen mit der Vorbereitung.',
      'Preparando': 'Deine Bestellung wird in unserer Werkstatt vorbereitet.',
      'Enviado': 'Deine Bestellung wurde versandt und ist unterwegs.',
      'Entregado': 'Deine Bestellung wurde zugestellt. Danke für deinen Einkauf!',
      'Cancelado': 'Deine Bestellung wurde storniert.'
    },
    statusFallback: 'Deine Bestellung wurde aktualisiert.'
  },
  fr: {
    confirmationSubject: (orderId) => `[LITUM3D #${orderId}] Confirmation de commande`,
    confirmationTitle: 'Commande confirmée',
    confirmationPreheader: (orderId) => `Nous avons bien reçu votre commande #${orderId}. Merci de votre confiance envers LITUM3D.`,
    greeting: (name) => `Bonjour ${name},`,
    intro: 'Merci pour votre achat chez LITUM3D. Nous préparons votre commande.',
    orderNumberLabel: 'Numéro de commande',
    dateLabel: 'Date',
    shippingAddressLabel: 'Adresse de livraison',
    phoneLabel: 'Téléphone',
    tableHeaders: { product: 'Produit', qty: 'Qté', price: 'Prix', subtotal: 'Sous-total' },
    shippingLabel: 'Livraison',
    freeShipping: 'Gratuite',
    totalLabel: 'TOTAL',
    ctaText: 'Aller sur LITUM3D',
    adapterLabel: 'Adaptateur USB',
    statusSubject: (orderId) => `[LITUM3D #${orderId}] Mise à jour de votre commande`,
    statusTitle: 'Mise à jour de votre commande',
    statusPreheader: (orderId) => `Il y a du nouveau concernant votre commande #${orderId}.`,
    statusIntro: (name) => `Bonjour ${name || 'client'},`,
    statusMessages: {
      'Pendiente': 'Votre commande est en attente de confirmation.',
      'Confirmado': 'Votre commande a été confirmée, nous allons commencer à la préparer.',
      'Preparando': 'Votre commande est en cours de préparation dans nos ateliers.',
      'Enviado': 'Votre commande a été expédiée et est en cours de livraison.',
      'Entregado': 'Votre commande a été livrée. Merci pour votre achat !',
      'Cancelado': 'Votre commande a été annulée.'
    },
    statusFallback: 'Votre commande a été mise à jour.'
  },
  en: {
    confirmationSubject: (orderId) => `[LITUM3D #${orderId}] Order confirmation`,
    confirmationTitle: 'Order confirmed',
    confirmationPreheader: (orderId) => `We've received your order #${orderId}. Thank you for trusting LITUM3D.`,
    greeting: (name) => `Hi ${name},`,
    intro: 'Thank you for your purchase at LITUM3D. We are preparing your order.',
    orderNumberLabel: 'Order number',
    dateLabel: 'Date',
    shippingAddressLabel: 'Shipping details',
    phoneLabel: 'Phone',
    tableHeaders: { product: 'Product', qty: 'Qty', price: 'Price', subtotal: 'Subtotal' },
    shippingLabel: 'Shipping',
    freeShipping: 'Free',
    totalLabel: 'TOTAL',
    ctaText: 'Go to LITUM3D',
    adapterLabel: 'USB adapter',
    statusSubject: (orderId) => `[LITUM3D #${orderId}] Order update`,
    statusTitle: 'Order update',
    statusPreheader: (orderId) => `There's news about your order #${orderId}.`,
    statusIntro: (name) => `Hi ${name || 'there'},`,
    statusMessages: {
      'Pendiente': 'Your order is awaiting confirmation.',
      'Confirmado': 'Your order has been confirmed and we will start preparing it.',
      'Preparando': 'Your order is being prepared in our workshop.',
      'Enviado': 'Your order has been shipped and is on its way.',
      'Entregado': 'Your order has been delivered. Thank you for your purchase!',
      'Cancelado': 'Your order has been cancelled.'
    },
    statusFallback: 'Your order has been updated.'
  }
};

// normalizeLocale ahora se importa de config/locales.js (normalizador
// central); COPY usa las mismas 3 claves (es/de/fr) que ALLOWED_LOCALES.

// --- Tabla de artículos (compartida entre email cliente y email Admin) ------

function renderItemsTableHtml(items, currency, headers) {
  const rows = items.map((item) => {
    const variantLines = describeVariants(item.variantSelections);
    const extrasLines = describeExtras(item.extras, 'Adaptador USB');
    const detailLines = [...variantLines, ...extrasLines];
    const lineSubtotalCents = item.unitPriceCents * item.quantity;
    return `
      <tr>
        <td style="padding:8px; border-bottom:1px solid rgba(255,255,255,0.08); color:#e5e7eb;">
          ${escapeHtml(item.productName)}${item.modelName ? ' · ' + escapeHtml(item.modelName) : ''}
          ${detailLines.length ? `<br><small style="opacity:0.75;">${detailLines.map(escapeHtml).join(' · ')}</small>` : ''}
          ${item.notes ? `<br><small style="opacity:0.75;">Notas: ${escapeHtml(item.notes)}</small>` : ''}
        </td>
        <td style="padding:8px; border-bottom:1px solid rgba(255,255,255,0.08); text-align:center; color:#e5e7eb;">${item.quantity}</td>
        <td style="padding:8px; border-bottom:1px solid rgba(255,255,255,0.08); text-align:right; color:#e5e7eb;">${formatMoney(item.unitPriceCents, currency)}</td>
        <td style="padding:8px; border-bottom:1px solid rgba(255,255,255,0.08); text-align:right; color:#e5e7eb;">${formatMoney(lineSubtotalCents, currency)}</td>
      </tr>
    `;
  }).join('');

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%; border-collapse:collapse; border:1px solid rgba(255,255,255,0.08);">
      <thead>
        <tr style="background:rgba(255,255,255,0.04);">
          <th style="padding:10px; text-align:left; font-size:12px; color:#cbd5f5;">${escapeHtml(headers.product)}</th>
          <th style="padding:10px; text-align:center; font-size:12px; color:#cbd5f5;">${escapeHtml(headers.qty)}</th>
          <th style="padding:10px; text-align:right; font-size:12px; color:#cbd5f5;">${escapeHtml(headers.price)}</th>
          <th style="padding:10px; text-align:right; font-size:12px; color:#cbd5f5;">${escapeHtml(headers.subtotal)}</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderItemsTableText(items, currency) {
  return items.map((item) => {
    const variantLines = describeVariants(item.variantSelections);
    const extrasLines = describeExtras(item.extras, 'Adaptador USB');
    const detail = [...variantLines, ...extrasLines].join(', ');
    const lineSubtotalCents = item.unitPriceCents * item.quantity;
    const name = `${item.productName}${item.modelName ? ' · ' + item.modelName : ''}`;
    return `- ${name}${detail ? ` (${detail})` : ''} x${item.quantity}: ${formatMoney(lineSubtotalCents, currency)}`;
  }).join('\n');
}

// --- 1) Confirmación de pedido (cliente) -------------------------------------

/**
 * @param {object} p
 * @param {string} [p.locale='es']
 * @param {number|string} p.orderId
 * @param {Date} p.orderDate
 * @param {object} p.customerData - {name,email,phone,address,city,zip,country}
 * @param {Array} p.items - snapshot.items (productName, modelName, variantSelections, extras, quantity, unitPriceCents, notes)
 * @param {object} p.totals - {shippingCents, totalCents} (nunca netCents/taxCents: sin IVA)
 * @param {string} p.currency
 */
function buildOrderConfirmationEmail({ locale = 'es', orderId, orderDate, customerData, items, totals, currency }) {
  const loc = normalizeLocale(locale);
  const c = COPY[loc];
  const baseUrl = getBaseUrl();

  const shippingLine = totals.shippingCents > 0 ? formatMoney(totals.shippingCents, currency) : c.freeShipping;

  const contentHtml = `
    <p style="margin:0 0 8px 0; color:#e5e7eb;">${escapeHtml(c.greeting(customerData.name))}</p>
    <p style="margin:0 0 18px 0; color:${'#b6c2d9'};">${escapeHtml(c.intro)}</p>

    <div style="margin:0 0 18px 0; padding:12px 14px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:12px; font-size:13px; color:#cbd5f5;">
      <div>${escapeHtml(c.orderNumberLabel)}: <strong>#${escapeHtml(String(orderId))}</strong></div>
      <div>${escapeHtml(c.dateLabel)}: <strong>${escapeHtml(formatDate(orderDate, loc))}</strong></div>
    </div>

    <div style="margin-bottom:16px;">
      ${renderItemsTableHtml(items, currency, c.tableHeaders)}
    </div>

    <div style="padding:12px 14px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:12px;">
      <div style="display:flex; justify-content:space-between; color:#cbd5f5; font-size:13px;">
        <span>${escapeHtml(c.shippingLabel)}</span><span>${shippingLine}</span>
      </div>
      <div style="margin-top:8px; display:flex; justify-content:space-between; font-weight:800; font-size:16px; color:#e0ad61;">
        <span>${escapeHtml(c.totalLabel)}</span><span>${formatMoney(totals.totalCents, currency)}</span>
      </div>
    </div>

    <div style="margin-top:16px; padding:12px 14px; background:rgba(224,173,97,0.08); border:1px solid rgba(224,173,97,0.35); border-radius:12px;">
      <div style="font-weight:700; color:#f0c070; font-size:14px;">${escapeHtml(c.shippingAddressLabel)}</div>
      <div style="margin-top:6px; color:#d0d5e0; font-size:13px; line-height:1.5;">
        ${escapeHtml(customerData.name)}<br>
        ${escapeHtml(customerData.address)}<br>
        ${escapeHtml(customerData.zip)} ${escapeHtml(customerData.city)}${customerData.country ? ', ' + escapeHtml(customerData.country) : ''}<br>
        ${escapeHtml(c.phoneLabel)}: ${escapeHtml(customerData.phone)}
      </div>
    </div>

    <div style="margin-top:16px;">
      <a href="${baseUrl}" style="display:inline-block; padding:12px 18px; background:linear-gradient(135deg,#e0ad61,#f0c070); color:#1a1a2e; border-radius:10px; text-decoration:none; font-weight:800; font-size:14px;">${escapeHtml(c.ctaText)}</a>
    </div>
  `;

  const contentText = [
    c.greeting(customerData.name),
    c.intro,
    '',
    `${c.orderNumberLabel}: #${orderId}`,
    `${c.dateLabel}: ${formatDate(orderDate, loc)}`,
    '',
    renderItemsTableText(items, currency),
    '',
    `${c.shippingLabel}: ${shippingLine}`,
    `${c.totalLabel}: ${formatMoney(totals.totalCents, currency)}`,
    '',
    `${c.shippingAddressLabel}:`,
    customerData.name,
    customerData.address,
    `${customerData.zip} ${customerData.city}${customerData.country ? ', ' + customerData.country : ''}`,
    `${c.phoneLabel}: ${customerData.phone}`,
    '',
    baseUrl
  ].join('\n');

  const { html, text } = renderLitumEmail({
    locale: loc,
    preheader: c.confirmationPreheader(orderId),
    title: c.confirmationTitle,
    contentHtml,
    contentText,
    orderId
  });

  return { subject: c.confirmationSubject(orderId), html, text };
}

// --- 2) Nuevo pedido pagado (Admin) ------------------------------------------
// Email interno de LITUM3D (equipo, no cliente): siempre en español, como el
// resto del panel Admin (views/admin-dashboard.html). Reply-To se fija al
// email del CLIENTE (no a contact@litum3d.com) para que Admin pueda
// responder directamente pulsando "Responder" -- ver informe, sección 8.

function buildAdminNewOrderEmail({ orderId, orderDate, customerData, items, totals, currency, hasPhotos }) {
  const baseUrl = getBaseUrl();
  const shippingLine = totals.shippingCents > 0 ? formatMoney(totals.shippingCents, currency) : 'Gratis';

  const photosNotice = hasPhotos
    ? `<p style="margin:14px 0 0 0;"><a href="${baseUrl}/admin" style="color:#e0ad61; font-weight:700;">Ver imágenes del pedido en el panel Admin →</a></p>`
    : '';

  const contentHtml = `
    <p style="margin:0 0 14px 0; color:#e5e7eb; font-size:15px;">Nuevo pedido pagado <strong>#${escapeHtml(String(orderId))}</strong> · ${escapeHtml(formatDate(orderDate, 'es'))}</p>

    <div style="margin:0 0 16px 0; padding:12px 14px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:12px; font-size:13px; color:#cbd5f5; line-height:1.6;">
      <div style="font-weight:700; color:#f8fafc; margin-bottom:4px;">Cliente</div>
      <div>Nombre: <strong>${escapeHtml(customerData.name)}</strong></div>
      <div>Email: <strong>${escapeHtml(customerData.email)}</strong></div>
      <div>Teléfono: ${escapeHtml(customerData.phone)}</div>
      <div>País: ${escapeHtml(customerData.country || '—')}</div>
      <div>Dirección: ${escapeHtml(customerData.address)}, ${escapeHtml(customerData.zip)} ${escapeHtml(customerData.city)}</div>
    </div>

    ${renderItemsTableHtml(items, currency, { product: 'Producto', qty: 'Cant.', price: 'Precio', subtotal: 'Subtotal' })}

    <div style="margin-top:14px; padding:12px 14px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:12px;">
      <div style="display:flex; justify-content:space-between; color:#cbd5f5; font-size:13px;">
        <span>Envío</span><span>${shippingLine}</span>
      </div>
      <div style="margin-top:8px; display:flex; justify-content:space-between; font-weight:800; font-size:16px; color:#e0ad61;">
        <span>TOTAL</span><span>${formatMoney(totals.totalCents, currency)}</span>
      </div>
    </div>
    ${photosNotice}
    <p style="margin-top:16px; color:#b6c2d9; font-size:13px;">Prepara el envío y actualiza el estado del pedido desde el panel Admin.</p>
  `;

  const contentText = [
    `Nuevo pedido pagado #${orderId} · ${formatDate(orderDate, 'es')}`,
    '',
    'Cliente:',
    customerData.name,
    customerData.email,
    customerData.phone,
    `País: ${customerData.country || '—'}`,
    `${customerData.address}, ${customerData.zip} ${customerData.city}`,
    '',
    renderItemsTableText(items, currency),
    '',
    `Envío: ${shippingLine}`,
    `TOTAL: ${formatMoney(totals.totalCents, currency)}`,
    '',
    `Panel Admin: ${baseUrl}/admin`
  ].join('\n');

  const { html, text } = renderLitumEmail({
    locale: 'es',
    preheader: `Nuevo pedido #${orderId} pagado por ${customerData.name}`,
    title: '¡Nuevo pedido pagado!',
    contentHtml,
    contentText,
    orderId,
    showSupport: false
  });

  return { subject: `Nuevo Pedido Pagado #${orderId} - ${customerData.name}`, html, text };
}

// --- 3) Cambio de estado (cliente) -------------------------------------------

function buildStatusChangeEmail({ locale = 'es', orderId, customerName, newStatus }) {
  const loc = normalizeLocale(locale);
  const c = COPY[loc];
  const message = c.statusMessages[newStatus] || c.statusFallback;

  const contentHtml = `
    <p style="margin:0 0 8px 0; color:#e5e7eb;">${escapeHtml(c.statusIntro(customerName))}</p>
    <p style="margin:0 0 16px 0; color:#b6c2d9;">${escapeHtml(message)}</p>
    <div style="padding:12px 14px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:12px; font-size:13px; color:#cbd5f5;">
      <div>${escapeHtml(c.orderNumberLabel)}: <strong>#${escapeHtml(String(orderId))}</strong></div>
      <div style="margin-top:4px;">${escapeHtml(newStatus)}</div>
    </div>
  `;

  const contentText = [
    c.statusIntro(customerName),
    message,
    '',
    `${c.orderNumberLabel}: #${orderId}`,
    newStatus
  ].join('\n');

  const { html, text } = renderLitumEmail({
    locale: loc,
    preheader: c.statusPreheader(orderId),
    title: c.statusTitle,
    contentHtml,
    contentText,
    orderId
  });

  return { subject: c.statusSubject(orderId), html, text };
}

module.exports = {
  formatMoney,
  formatDate,
  buildOrderConfirmationEmail,
  buildAdminNewOrderEmail,
  buildStatusChangeEmail
};
