// admin-fetch.js - helper central para llamadas del panel Admin
// (P0-SECURITY-01, sección 45/46).
//
// Adjunta automáticamente el token CSRF (header X-CSRF-Token) a cualquier
// mutación (POST/PUT/PATCH/DELETE) hacia el backend, para no repetir la
// lógica en cada página admin. El token se pide una vez a
// GET /admin/api/csrf-token y se guarda solo en memoria (nunca localStorage):
// si la página se recarga, se vuelve a pedir.
(function () {
  let csrfTokenPromise = null;

  async function fetchCsrfToken() {
    const res = await fetch('/admin/api/csrf-token');
    if (!res.ok) {
      throw new Error('No se pudo obtener el token CSRF (sesión no válida)');
    }
    const data = await res.json();
    return data.csrfToken;
  }

  function getCsrfToken(forceRefresh) {
    if (forceRefresh || !csrfTokenPromise) {
      csrfTokenPromise = fetchCsrfToken().catch((err) => {
        csrfTokenPromise = null;
        throw err;
      });
    }
    return csrfTokenPromise;
  }

  const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  async function adminFetch(url, options) {
    options = options || {};
    const method = (options.method || 'GET').toUpperCase();
    if (!MUTATING_METHODS.has(method)) {
      return fetch(url, options);
    }

    let token = await getCsrfToken(false);
    let headers = new Headers(options.headers || {});
    headers.set('X-CSRF-Token', token);
    let response = await fetch(url, Object.assign({}, options, { headers: headers }));

    if (response.status === 403) {
      // El token pudo quedar obsoleto (sesión regenerada en otra pestaña,
      // etc.): se refresca una vez y se reintenta antes de rendirse.
      token = await getCsrfToken(true);
      headers = new Headers(options.headers || {});
      headers.set('X-CSRF-Token', token);
      response = await fetch(url, Object.assign({}, options, { headers: headers }));
    }

    return response;
  }

  window.adminFetch = adminFetch;
})();
