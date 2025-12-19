const form = document.getElementById('contact-form');
const status = document.getElementById('status');

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const btn = form.querySelector('button');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Enviando...';
  
  // Clear previous status
  status.innerHTML = '';
  
  const data = Object.fromEntries(new FormData(form).entries());
  
  try {
    const res = await fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const json = await res.json();
    
    if (json.ok) {
      status.className = 'status success';
      status.textContent = '✓ Mensaje enviado. Te responderemos pronto.';
      form.reset();
    } else {
      status.className = 'status error';
      status.textContent = '✗ Error al enviar. Intenta de nuevo.';
    }
  } catch (err) {
    console.error(err);
    status.className = 'status error';
    status.textContent = '✗ Error de conexión. Intenta más tarde.';
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

