// Cookie Consent Banner
(function() {
  const COOKIE_CONSENT_KEY = 'cookie_consent';
  const COOKIE_SETTINGS_KEY = 'cookie_settings';

  function getCookieConsent() {
    const cookie = document.cookie.split('; ').find(row => row.startsWith(COOKIE_CONSENT_KEY + '='));
    return cookie ? JSON.parse(decodeURIComponent(cookie.split('=')[1])) : null;
  }

  function showBanner() {
    const banner = document.createElement('div');
    banner.id = 'cookie-banner';
    banner.innerHTML = `
      <div style="background-color: #2c3e50; color: white; padding: 20px; position: fixed; bottom: 0; left: 0; right: 0; z-index: 9999; box-shadow: 0 -2px 10px rgba(0,0,0,0.2);">
        <div style="max-width: 1200px; margin: 0 auto; display: flex; align-items: center; gap: 20px; flex-wrap: wrap;">
          <div style="flex: 1; min-width: 250px;">
            <h4 style="margin: 0 0 10px 0; font-size: 1.1em;">🍪 Política de Cookies</h4>
            <p style="margin: 0; font-size: 0.9em; line-height: 1.5;">
              Utilizamos cookies para mejorar tu experiencia, personalizar contenido y analizar tráfico. 
              <a href="/privacy-policy.html" style="color: #3498db; text-decoration: none;">Leer más</a>
            </p>
          </div>
          <div style="display: flex; gap: 10px; flex-wrap: wrap;">
            <button id="cookie-only-essential" style="padding: 10px 20px; background-color: #95a5a6; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">
              Solo Esenciales
            </button>
            <button id="cookie-customize" style="padding: 10px 20px; background-color: #34495e; color: white; border: 1px solid white; border-radius: 4px; cursor: pointer; font-weight: bold;">
              Personalizar
            </button>
            <button id="cookie-accept-all" style="padding: 10px 20px; background-color: #27ae60; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">
              Aceptar Todo
            </button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(banner);

    document.getElementById('cookie-accept-all').addEventListener('click', () => acceptAllCookies());
    document.getElementById('cookie-only-essential').addEventListener('click', () => acceptEssentialOnly());
    document.getElementById('cookie-customize').addEventListener('click', () => showCustomizeModal());
  }

  function acceptAllCookies() {
    setCookieConsent({ essential: true, analytics: true, functional: true });
    loadAnalytics();
    removeBanner();
  }

  function acceptEssentialOnly() {
    setCookieConsent({ essential: true, analytics: false, functional: false });
    removeBanner();
  }

  function setCookieConsent(settings) {
    const date = new Date();
    date.setTime(date.getTime() + (365 * 24 * 60 * 60 * 1000)); // 1 año
    const expires = "expires=" + date.toUTCString();
    document.cookie = COOKIE_CONSENT_KEY + "=" + encodeURIComponent(JSON.stringify(settings)) + ";" + expires + ";path=/";
  }

  function removeBanner() {
    const banner = document.getElementById('cookie-banner');
    if (banner) {
      banner.style.transition = 'opacity 0.3s';
      banner.style.opacity = '0';
      setTimeout(() => banner.remove(), 300);
    }
  }

  function showCustomizeModal() {
    const modal = document.createElement('div');
    modal.id = 'cookie-modal';
    modal.innerHTML = `
      <div style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background-color: rgba(0,0,0,0.7); z-index: 10000; display: flex; align-items: center; justify-content: center;">
        <div style="background-color: white; border-radius: 8px; padding: 30px; max-width: 500px; width: 90%; box-shadow: 0 10px 40px rgba(0,0,0,0.3);">
          <h2 style="margin-top: 0; color: #2c3e50;">Personalizar Cookies</h2>
          
          <div style="margin: 20px 0; padding: 15px; background-color: #ecf0f1; border-radius: 4px;">
            <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
              <input type="checkbox" id="cookie-essential-check" checked disabled style="cursor: not-allowed;">
              <div>
                <strong>Cookies Esenciales</strong>
                <p style="margin: 5px 0 0 0; font-size: 0.9em; color: #666;">Necesarias para el funcionamiento del sitio (no se pueden desactivar)</p>
              </div>
            </label>
          </div>

          <div style="margin: 20px 0; padding: 15px; background-color: #ecf0f1; border-radius: 4px;">
            <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
              <input type="checkbox" id="cookie-analytics-check" style="cursor: pointer;">
              <div>
                <strong>Cookies de Análisis</strong>
                <p style="margin: 5px 0 0 0; font-size: 0.9em; color: #666;">Google Analytics para entender cómo usas el sitio</p>
              </div>
            </label>
          </div>

          <div style="margin: 20px 0; padding: 15px; background-color: #ecf0f1; border-radius: 4px;">
            <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
              <input type="checkbox" id="cookie-functional-check" style="cursor: pointer;">
              <div>
                <strong>Cookies Funcionales</strong>
                <p style="margin: 5px 0 0 0; font-size: 0.9em; color: #666;">Para personalizar tu experiencia y recordar preferencias</p>
              </div>
            </label>
          </div>

          <div style="display: flex; gap: 10px; margin-top: 25px;">
            <button id="cookie-modal-cancel" style="flex: 1; padding: 12px; background-color: #95a5a6; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">
              Cancelar
            </button>
            <button id="cookie-modal-save" style="flex: 1; padding: 12px; background-color: #3498db; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">
              Guardar Preferencias
            </button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('cookie-modal-cancel').addEventListener('click', () => modal.remove());
    document.getElementById('cookie-modal-save').addEventListener('click', () => {
      const settings = {
        essential: true,
        analytics: document.getElementById('cookie-analytics-check').checked,
        functional: document.getElementById('cookie-functional-check').checked
      };
      setCookieConsent(settings);
      if (settings.analytics) {
        loadAnalytics();
      }
      modal.remove();
      removeBanner();
    });
  }

  function loadAnalytics() {
    // Google Analytics
    if (window.gtag) {
      gtag('consent', 'update', {
        'analytics_storage': 'granted'
      });
    } else {
      const script = document.createElement('script');
      script.async = true;
      script.src = 'https://www.googletagmanager.com/gtag/js?id=GA_ID';
      document.head.appendChild(script);
      
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());
      gtag('config', 'GA_ID', { 'anonymize_ip': true });
    }
  }

  // Inicializar al cargar la página
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (!getCookieConsent()) {
        showBanner();
      }
    });
  } else {
    if (!getCookieConsent()) {
      showBanner();
    }
  }
})();
