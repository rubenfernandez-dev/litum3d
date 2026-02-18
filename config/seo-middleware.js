/**
 * SEO Middleware
 * Inyecta datos de SEO en todas las respuestas
 */

const { generateOrganizationSchema } = require('./seo-utils');
const seoConfig = require('./seo');

const seoMiddleware = (req, res, next) => {
  // Obtener idioma de los query params o headers
  const lang = req.query.lang || 
               (req.headers['accept-language'] && req.headers['accept-language'].startsWith('fr') ? 'fr' :
                req.headers['accept-language'] && req.headers['accept-language'].startsWith('de') ? 'de' : 'es');

  // Agregar info de SEO a res.locals
  res.locals.seoConfig = seoConfig;
  res.locals.lang = lang;
  res.locals.organizationSchema = JSON.stringify(generateOrganizationSchema());

  // Helpers para vistas
  res.locals.getPageSeo = (page) => seoConfig.pages[page]?.[lang] || {};
  res.locals.getProductName = (productId) => {
    const product = seoConfig.products.find(p => p.id === productId);
    return product?.[lang]?.name || '';
  };

  next();
};

module.exports = seoMiddleware;
