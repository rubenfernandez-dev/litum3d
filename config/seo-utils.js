/**
 * SEO Utilities
 * Funciones para generar meta tags, schema markup y sitemap
 */

const seoConfig = require('./seo');

/**
 * Genera meta tags para una página
 */
const generateMetaTags = (page, lang = 'es') => {
  const pageData = seoConfig.pages[page]?.[lang] || {};
  const baseUrl = seoConfig.baseUrl;
  const siteName = seoConfig.siteName;

  return `
    <!-- Meta Tags SEO -->
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="${pageData.description || ''}">
    <meta name="keywords" content="${pageData.keywords || ''}">
    <meta name="author" content="${siteName}">
    <meta name="robots" content="index, follow">
    <meta name="language" content="${lang === 'es' ? 'es-ES' : lang === 'fr' ? 'fr-FR' : 'de-DE'}">
    
    <!-- Open Graph (Redes Sociales) -->
    <meta property="og:type" content="website">
    <meta property="og:title" content="${pageData.title || ''}">
    <meta property="og:description" content="${pageData.description || ''}">
    <meta property="og:image" content="${pageData.image || `${baseUrl}/img/logos/logo.png`}">
    <meta property="og:site_name" content="${siteName}">
    <meta property="og:url" content="${baseUrl}">
    
    <!-- Twitter Card -->
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${pageData.title || ''}">
    <meta name="twitter:description" content="${pageData.description || ''}">
    <meta name="twitter:image" content="${pageData.image || `${baseUrl}/img/logos/logo.png`}">
    
    <!-- Canonical URL -->
    <link rel="canonical" href="${baseUrl}">
  `;
};

/**
 * Genera schema.org JSON-LD para LocalBusiness (LITUM3D)
 */
const generateOrganizationSchema = () => {
  return {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    'name': 'LITUM3D',
    'image': `${seoConfig.baseUrl}/img/logos/logo.png`,
    'description': 'Litofanías personalizadas artesanales desde Suiza',
    'url': seoConfig.baseUrl,
    'telephone': seoConfig.contact.phone,
    'email': seoConfig.contact.email,
    'address': {
      '@type': 'PostalAddress',
      'streetAddress': 'Berna',
      'addressLocality': 'Berna',
      'addressCountry': 'CH'
    },
    'openingHoursSpecification': {
      '@type': 'OpeningHoursSpecification',
      'dayOfWeek': ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
      'opens': '09:00',
      'closes': '18:00'
    },
    'sameAs': [
      'https://wa.me/41772186229',
      'https://www.instagram.com/litum3d' // Agrega si tienes Instagram
    ]
  };
};

/**
 * Genera schema para un Producto
 */
const generateProductSchema = (product, lang = 'es') => {
  const productData = product[lang] || product.es;
  
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    'name': productData.name,
    'description': productData.description,
    'image': product.image,
    'brand': {
      '@type': 'Brand',
      'name': 'LITUM3D'
    },
    'offers': {
      '@type': 'Offer',
      'url': `${seoConfig.baseUrl}/shop`,
      'priceCurrency': product.currency,
      'price': product.price,
      'availability': 'https://schema.org/InStock'
    },
    'aggregateRating': {
      '@type': 'AggregateRating',
      'ratingValue': '4.8',
      'reviewCount': '50+'
    }
  };
};

/**
 * Genera schema para Review (reseña)
 */
const generateReviewSchema = (review) => {
  return {
    '@context': 'https://schema.org',
    '@type': 'Review',
    'author': {
      '@type': 'Person',
      'name': review.author || 'Cliente'
    },
    'reviewRating': {
      '@type': 'Rating',
      'ratingValue': review.rating || 5,
      'bestRating': '5',
      'worstRating': '1'
    },
    'reviewBody': review.text || '',
    'datePublished': review.date || new Date().toISOString()
  };
};

/**
 * Genera XML del Sitemap
 */
const generateSitemap = () => {
  const baseUrl = seoConfig.baseUrl;
  const languages = ['es', 'fr', 'de'];
  const pages = ['', 'shop', 'about', 'contact', 'gallery', 'testimonios'];

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n';

  pages.forEach(page => {
    languages.forEach(lang => {
      const path = page ? `/${page}-${lang}` : lang === 'es' ? '/' : `/${lang}`;
      const url = page ? `${baseUrl}/${page}${lang !== 'es' ? `-${lang}` : ''}` : baseUrl;
      
      xml += '  <url>\n';
      xml += `    <loc>${url}</loc>\n`;
      xml += '    <lastmod>' + new Date().toISOString().split('T')[0] + '</lastmod>\n';
      xml += '    <changefreq>weekly</changefreq>\n';
      xml += '    <priority>' + (page === '' ? '1.0' : '0.8') + '</priority>\n';
      xml += '  </url>\n';
    });
  });

  // Todas las páginas de productos
  seoConfig.products.forEach(product => {
    languages.forEach(lang => {
      const url = `${baseUrl}/products/${product.slug}${lang !== 'es' ? `?lang=${lang}` : ''}`;
      xml += '  <url>\n';
      xml += `    <loc>${url}</loc>\n`;
      xml += '    <lastmod>' + new Date().toISOString().split('T')[0] + '</lastmod>\n';
      xml += '    <changefreq>monthly</changefreq>\n';
      xml += '    <priority>0.7</priority>\n';
      xml += '  </url>\n';
    });
  });

  xml += '</urlset>';
  return xml;
};

module.exports = {
  generateMetaTags,
  generateOrganizationSchema,
  generateProductSchema,
  generateReviewSchema,
  generateSitemap
};
