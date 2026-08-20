/*
  LITUM3D - Transporte SMTP compartido (saneamiento del sistema de emails).

  Antes de esta unificación, routes/payments.js, routes/admin.js y
  routes/contact.js creaban CADA UNO su propio nodemailer.createTransport()
  con configuración ligeramente distinta -- en particular, routes/payments.js
  hardcodeaba `secure: false` ignorando SMTP_SECURE, mientras routes/admin.js
  y routes/contact.js ya respetaban esa variable de entorno. Este módulo es
  la ÚNICA fuente de verdad para la configuración de transporte SMTP y para
  el remitente (FROM) que se usa en todos los emails de LITUM3D.

  Variables de entorno (ver .env.example): SMTP_HOST, SMTP_PORT, SMTP_SECURE,
  SMTP_USER, SMTP_PASS. Ninguna se expone en logs/emails.
*/
// nodemailer se importa DENTRO de getTransporter() (nunca en el top-level
// del módulo) y no se memoiza ningún transporter entre llamadas: los tests
// existentes (scripts/check-admin-order-photos-retention.js) interceptan
// nodemailer sustituyendo require.cache['nodemailer'] en caliente, DESPUÉS
// de que routes/admin.js (y por tanto este módulo) ya se hayan cargado --
// una constante de módulo o un transporter cacheado capturarían la
// referencia real y nunca verían el fake. Crear el transporter es barato
// (no abre conexión, solo construye la configuración); la conexión SMTP
// real ocurre en sendMail(), no aquí.
function getTransporter() {
  const nodemailer = require('nodemailer');
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER || 'admin@example.com',
      pass: process.env.SMTP_PASS || ''
    }
  });
}

// El remitente SIEMPRE usa la cuenta autenticada real (SMTP_USER) -- nunca
// se cambia la dirección, solo se le añade un nombre de remitente legible.
// Ver sección 10 del informe de saneamiento de emails: "No cambiar FROM/SMTP
// si el proveedor necesita un remitente autenticado concreto".
function getFromAddress(displayName = 'LITUM3D') {
  const address = process.env.SMTP_USER || 'noreply@litum3d.com';
  return `${displayName} <${address}>`;
}

// Cabeceras de email (From display name / Subject) nunca deben aceptar
// saltos de línea de datos de usuario (inyección de cabeceras SMTP). No es
// escape HTML (esto no es HTML): solo se eliminan CR/LF.
function sanitizeHeaderValue(text) {
  return String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').trim();
}

module.exports = { getTransporter, getFromAddress, sanitizeHeaderValue };
