/*
  LITUM3D - Verifica que la serialización pública de reseñas (toPublicReview,
  en routes/reviews.js) es una allowlist: solo salen los campos que la UI
  pública necesita, y ningún campo interno o futuro se cuela por accidente
  (hallazgo de privacidad P0B).

  Prueba unitaria pura, sin base de datos ni servidor levantado.

  Uso: node scripts/check-public-reviews-no-email.js
*/
const assert = require('assert');
const { toPublicReview } = require('../routes/reviews');

// Campos que la UI pública (testimonios.js, home.js) realmente consume de una reseña.
const PUBLIC_FIELDS = ['nombre', 'rating', 'comentario', 'fecha_creacion', 'video_url', 'imagenes'];

function main() {
  // Caso A: reseña almacenada con email -> la versión pública no debe incluir email,
  // pero sí debe conservar el resto de campos previstos (nombre, rating, comentario...).
  const withEmail = {
    id: 1,
    nombre: 'Ana',
    email: 'ana@example.com',
    comentario: 'Genial, muy recomendable',
    rating: 5,
    estado: 'aprobada',
    destacada: false,
    fecha_creacion: '2026-01-01',
    video_url: null,
    imagenes: []
  };
  const publicA = toPublicReview(withEmail);
  assert.ok(!('email' in publicA), 'Caso A: la reseña pública no debe contener la clave "email"');
  assert.strictEqual(publicA.nombre, 'Ana', 'Caso A: nombre debe conservarse');
  assert.strictEqual(publicA.comentario, withEmail.comentario, 'Caso A: comentario debe conservarse');
  assert.strictEqual(publicA.rating, 5, 'Caso A: rating debe conservarse');

  // Caso B: reseña sin email (campo opcional no rellenado) -> sigue funcionando con normalidad.
  const withoutEmail = {
    id: 2,
    nombre: 'Luis',
    email: null,
    comentario: 'Muy buena calidad',
    rating: 4,
    estado: 'aprobada',
    destacada: false,
    fecha_creacion: '2026-02-01',
    video_url: null,
    imagenes: []
  };
  const publicB = toPublicReview(withoutEmail);
  assert.ok(!('email' in publicB), 'Caso B: no debe incluir "email" aunque sea null');
  assert.strictEqual(publicB.nombre, 'Luis', 'Caso B: la reseña sin email se sigue publicando con normalidad');

  // Caso C: acceso interno/admin. toPublicReview no muta el objeto original, por lo
  // que la fila cruda (la que consume /api/admin/reviews, que NO pasa por este filtro)
  // conserva el email para moderación/contacto legítimo.
  assert.strictEqual(withEmail.email, 'ana@example.com', 'Caso C: la fila original/admin conserva el email para uso interno');

  // Caso D: contrato de allowlist. Un objeto interno con campos de gestión/moderación
  // y datos claramente sensibles (incluyendo alguno inventado que no existe hoy en la
  // tabla) NO debe filtrar nada de eso a la representación pública. Esto prueba que
  // añadir una columna nueva a `reviews` no la expone automáticamente: solo aparecen
  // en la salida los campos que toPublicReview() construye explícitamente.
  const internalRow = {
    id: 3,
    nombre: 'Carla',
    rating: 5,
    comentario: 'Perfecto',
    fecha_creacion: '2026-03-01',
    video_url: null,
    imagenes: ['https://example.com/foto.jpg'],
    email: 'cliente@example.com',
    estado: 'aprobada',
    fecha_actualizacion: '2026-03-02T10:00:00Z',
    internal_note: 'NO PUBLICAR',
    verification_token: 'secret',
    ip_address: '203.0.113.5',
    future_unknown_field: 'columna añadida mañana sin tocar este test'
  };
  const publicD = toPublicReview(internalRow);
  const publicKeys = Object.keys(publicD).sort();

  assert.deepStrictEqual(
    publicKeys,
    [...PUBLIC_FIELDS].sort(),
    'Caso D: la salida pública debe contener EXACTAMENTE los campos permitidos, ni uno más'
  );

  for (const forbidden of ['email', 'estado', 'fecha_actualizacion', 'internal_note', 'verification_token', 'ip_address', 'future_unknown_field']) {
    assert.ok(!(forbidden in publicD), `Caso D: "${forbidden}" no debe aparecer en la representación pública`);
  }

  assert.strictEqual(publicD.nombre, 'Carla', 'Caso D: los campos públicos legítimos siguen presentes');
  assert.strictEqual(publicD.rating, 5, 'Caso D: los campos públicos legítimos siguen presentes');

  console.log('OK: la serialización pública de reseñas es una allowlist; ningún campo interno o futuro se filtra.');
}

main();
