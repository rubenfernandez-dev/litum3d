// Image Lightbox for hover-swap cards
document.addEventListener('DOMContentLoaded', function() {
  const lightbox = document.getElementById('image-lightbox');
  const lightboxImage = document.getElementById('lightbox-image');
  
  // Add click handlers to all hover-swap images
  const hoverSwapCards = document.querySelectorAll('.hover-swap-card .product-image');
  
  hoverSwapCards.forEach(card => {
    card.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      
      // Get the currently visible image (front or back)
      const frontImg = this.querySelector('.hover-swap-front');
      const backImg = this.querySelector('.hover-swap-back');
      
      // Check which image is visible based on opacity
      const frontOpacity = window.getComputedStyle(frontImg).opacity;
      const currentImage = frontOpacity === '1' ? frontImg : backImg;
      
      // Set lightbox image
      lightboxImage.src = currentImage.src;
      lightboxImage.alt = currentImage.alt;
      
      // Show lightbox
      lightbox.classList.add('active');
      document.body.style.overflow = 'hidden';
    });
  });
  
  // Close lightbox on click
  lightbox.addEventListener('click', closeLightbox);
  
  // Prevent closing when clicking the image itself
  lightboxImage.addEventListener('click', function(e) {
    e.stopPropagation();
  });
});

function closeLightbox() {
  const lightbox = document.getElementById('image-lightbox');
  lightbox.classList.remove('active');
  document.body.style.overflow = '';
}

// Close on ESC key
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    closeLightbox();
  }
});
