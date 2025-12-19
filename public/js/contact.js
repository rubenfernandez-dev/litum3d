const form = document.getElementById('contact-form');
const status = document.getElementById('status');

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  status.textContent = 'Enviando...';
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    const res = await fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const json = await res.json();
    if (json.ok) {
      status.textContent = 'Mensaje enviado.';
      form.reset();
    } else {
      status.textContent = 'Error al enviar.';
    }
  } catch (err) {
    console.error(err);
    status.textContent = 'Error de red.';
  }
});
