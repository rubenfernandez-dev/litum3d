/**
 * SEO Configuration
 * Centraliza toda la información de SEO del sitio
 */

const seoConfig = {
  // Base del sitio
  baseUrl: process.env.BASE_URL || 'https://example.com',
  siteName: 'LITUM3D',
  
  // Contacto (para schema)
  contact: {
    phone: '+41772186229',
    email: 'contact@example.com',
    address: 'Lüscherz, Suiza',
    hours: 'Monday-Friday 9:00-18:00'
  },

  // Páginas principales
  pages: {
    home: {
      es: {
        title: 'Litofanías Personalizadas | LITUM3D - Lámparas 3D desde Suiza',
        description: 'Transforma tus fotos en litofanías personalizadas. Lámparas 3D artesanales desde Suiza. Envío rápido, garantía y calidad premium.',
        keywords: 'litofanía personalizada, lámpara 3D, regalo personalizado, lampara foto, impresión 3D Suiza',
        image: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769592130/ChatGPT_Image_27_ene_2026_10_36_05_lc9iop.png'
      },
      fr: {
        title: 'Lithophanies Personnalisées | LITUM3D - Lampes 3D de Suisse',
        description: 'Transformez vos photos en lithophanies personnalisées. Lampes 3D artisanales fabriquées en Suisse. Livraison rapide, garantie et qualité premium.',
        keywords: 'lithophanie personnalisée, lampe 3D, cadeau personnalisé, lampe photo, impression 3D Suisse',
        image: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769592130/ChatGPT_Image_27_ene_2026_10_36_05_lc9iop.png'
      },
      de: {
        title: 'Personalisierte Lithophanien | LITUM3D - 3D-Lampen aus der Schweiz',
        description: 'Verwandeln Sie Ihre Fotos in personalisierte Lithophanien. Handgefertigte 3D-Lampen aus der Schweiz. Schneller Versand, Garantie und Premium-Qualität.',
        keywords: 'Lithophanie personalisiert, 3D-Lampe, personalisiertes Geschenk, Fotolampe, 3D-Druck Schweiz',
        image: 'https://res.cloudinary.com/du4fvhum1/image/upload/v1769592130/ChatGPT_Image_27_ene_2026_10_36_05_lc9iop.png'
      }
    },
    shop: {
      es: {
        title: 'Tienda | Litofanías Personalizadas - LITUM3D',
        description: 'Compra litofanías personalizadas. Mesa, techo y pared. Personalización fácil, fabricación en Suiza, envío rápido.',
        keywords: 'comprar litofanía, lampara personalizada, regalo 3D, litofania precio'
      },
      fr: {
        title: 'Boutique | Lithophanies Personnalisées - LITUM3D',
        description: 'Achetez des lithophanies personnalisées. Bureau, plafond et mur. Personnalisation facile, fabrication en Suisse, livraison rapide.',
        keywords: 'acheter lithophanie, lampe personnalisée, cadeau 3D, lithophanie prix'
      },
      de: {
        title: 'Shop | Personalisierte Lithophanien - LITUM3D',
        description: 'Kaufen Sie personalisierte Lithophanien. Tisch, Decke und Wand. Einfache Personalisierung, Herstellung in der Schweiz, schneller Versand.',
        keywords: 'Lithophanie kaufen, personalisierte Lampe, 3D-Geschenk, Lithophanie Preis'
      }
    },
    about: {
      es: {
        title: 'Sobre Nosotros | LITUM3D - 8 años de Experiencia',
        description: '8 años de experiencia en impresión 3D artesanal. Calidad premium, garantía 100%, procesos transparentes. Conoce nuestro equipo.',
        keywords: 'sobre litum3d, impresión 3D profesional, litofanías artesanales, empresa Suiza'
      },
      fr: {
        title: 'À Propos | LITUM3D - 8 ans d\'Expérience',
        description: '8 ans d\'expérience en impression 3D artisanale. Qualité premium, garantie 100%, processus transparents. Rencontrez notre équipe.',
        keywords: 'à propos litum3d, impression 3D professionnelle, lithophanies artisanales, entreprise Suisse'
      },
      de: {
        title: 'Über Uns | LITUM3D - 8 Jahre Erfahrung',
        description: '8 Jahre Erfahrung in handwerklichem 3D-Druck. Premium-Qualität, 100% Garantie, transparente Prozesse. Lernen Sie unser Team kennen.',
        keywords: 'über litum3d, professioneller 3D-Druck, handgefertigte Lithophanien, Schweizer Unternehmen'
      }
    },
    gallery: {
      es: {
        title: 'Galería | Litofanías Personalizadas - LITUM3D',
        description: 'Galería de litofanías personalizadas. Mira ejemplos reales creados por clientes y nuestros artesanos.',
        keywords: 'galería litofanías, ejemplos litofania, trabajos 3D'
      },
      fr: {
        title: 'Galerie | Lithophanies Personnalisées - LITUM3D',
        description: 'Galerie de lithophanies personnalisées. Découvrez des exemples réels créés par nos clients et artisans.',
        keywords: 'galerie lithophanies, exemples lithophanie, travaux 3D'
      },
      de: {
        title: 'Galerie | Personalisierte Lithophanien - LITUM3D',
        description: 'Galerie personalisierter Lithophanien. Sehen Sie reale Beispiele von Kunden und unseren Handwerkern.',
        keywords: 'Lithophanie-Galerie, Lithophanie-Beispiele, 3D-Arbeiten'
      }
    },
    testimonios: {
      es: {
        title: 'Reseñas y Testimonios | LITUM3D',
        description: 'Lee lo que dicen nuestros clientes. Reseñas con 5 estrellas, fotos reales y experiencias de clientes satisfechos.',
        keywords: 'reseñas litofania, opiniones clientes, testimonios 3D'
      },
      fr: {
        title: 'Avis et Témoignages | LITUM3D',
        description: 'Lisez ce que disent nos clients. Avis 5 étoiles, photos réelles et expériences de clients satisfaits.',
        keywords: 'avis lithophanie, opinions clients, témoignages 3D'
      },
      de: {
        title: 'Bewertungen und Testimonials | LITUM3D',
        description: 'Lesen Sie, was unsere Kunden sagen. 5-Sterne-Bewertungen, echte Fotos und Erfahrungen zufriedener Kunden.',
        keywords: 'Lithophanie-Bewertungen, Kundenmeinungen, 3D-Testimonials'
      }
    },
    contact: {
      es: {
        title: 'Contacto | LITUM3D',
        description: 'Ponte en contacto con LITUM3D. WhatsApp, email o formulario de contacto. Disponible lunes a viernes 9:00-18:00.',
        keywords: 'contacto litum3d, whatsapp, email'
      },
      fr: {
        title: 'Contact | LITUM3D',
        description: 'Contactez LITUM3D. WhatsApp, email ou formulaire de contact. Disponible lundi à vendredi 9h00-18h00.',
        keywords: 'contact litum3d, whatsapp, email'
      },
      de: {
        title: 'Kontakt | LITUM3D',
        description: 'Kontaktieren Sie LITUM3D. WhatsApp, E-Mail oder Kontaktformular. Verfügbar Montag bis Freitag 9:00-18:00 Uhr.',
        keywords: 'kontakt litum3d, whatsapp, email'
      }
    }
  },

  // Productos para schema
  products: [
    {
      id: 1,
      slug: 'mesa-personalizada',
      es: { name: 'Lampara de Litofanía de mesa Personalizada', description: 'Ilumina Recuerdos: Litofanía Personalizada para Mesita o Escritorio' },
      fr: { name: 'Lampe de Table Personnalisée Lithophanie', description: 'Illuminez les Souvenirs: Lithophanie Personnalisée pour Bureau' },
      de: { name: 'Personalisierte Tischlampe Lithophanie', description: 'Erleuchten Sie Erinnerungen: Personalisierte Lithophanie für Tisch' },
      price: 49.99,
      currency: 'EUR',
      image: 'https://litum3d.com/img/productos/mesa1.png'
    },
    {
      id: 2,
      slug: 'techo-personalizado',
      es: { name: 'Lámparas de Techo Personalizadas', description: 'Ilumina Recuerdos: Litofanía Personalizada para Techo' },
      fr: { name: 'Lampes au Plafond Personnalisées', description: 'Illuminez les Souvenirs: Lithophanie Personnalisée pour Plafond' },
      de: { name: 'Personalisierte Deckenleuchten', description: 'Erleuchten Sie Erinnerungen: Personalisierte Lithophanie für Decke' },
      price: 139.99,
      currency: 'EUR',
      image: 'https://litum3d.com/img/productos/techo1.jpg'
    },
    {
      id: 3,
      slug: 'pared-personalizada',
      es: { name: 'Litofanías de Pared Personalizadas', description: 'Litofanías Personalizadas, para Pared' },
      fr: { name: 'Lithophanies Murales Personnalisées', description: 'Lithophanies Personnalisées pour Mur' },
      de: { name: 'Personalisierte Wandlithophanien', description: 'Personalisierte Lithophanien für Wand' },
      price: 59.99,
      currency: 'EUR',
      image: 'https://litum3d.com/img/productos/pared1.jpg'
    }
  ]
};

module.exports = seoConfig;
