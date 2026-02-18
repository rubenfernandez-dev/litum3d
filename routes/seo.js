/**
 * SEO Routes
 * Rutas para sitemap, robots.txt y meta tags dinámicos
 */

const express = require('express');
const router = express.Router();
const { generateSitemap } = require('../config/seo-utils');

/**
 * GET /sitemap.xml
 * Genera el sitemap dinámicamente
 */
router.get('/sitemap.xml', (req, res) => {
  try {
    const sitemap = generateSitemap();
    res.header('Content-Type', 'application/xml; charset=utf-8');
    res.send(sitemap);
  } catch (error) {
    console.error('Error generating sitemap:', error);
    res.status(500).send('Error generating sitemap');
  }
});

/**
 * GET /robots.txt
 * Archivo robots.txt para motores de búsqueda
 */
router.get('/robots.txt', (req, res) => {
  const baseUrl = process.env.BASE_URL || 'https://litum3d.com';
  
  const robotsTxt = `# LITUM3D robots.txt
User-agent: *
Allow: /
Disallow: /admin
Disallow: /admin-*
Disallow: /uploads/
Disallow: /scripts/
Disallow: /config/

# Especificar el sitemap
Sitemap: ${baseUrl}/sitemap.xml

# Google
User-agent: Googlebot
Allow: /
Crawl-delay: 0

# Bing
User-agent: Bingbot
Allow: /
Crawl-delay: 1

# Meta Bot
User-agent: facebookexternalhit
Allow: /
`;

  res.header('Content-Type', 'text/plain; charset=utf-8');
  res.send(robotsTxt);
});

module.exports = router;
