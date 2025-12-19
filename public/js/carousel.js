// Carousel functionality
let currentSlide = 0;
const slides = document.querySelectorAll('.carousel-slide');
const totalSlides = slides.length;

function showSlide(n) {
  slides.forEach(s => s.classList.remove('active'));
  slides[n].classList.add('active');
  updateDots(n);
}

function moveCarousel(dir) {
  currentSlide = (currentSlide + dir + totalSlides) % totalSlides;
  showSlide(currentSlide);
}

function updateDots(active) {
  const dots = document.querySelectorAll('.carousel-dot');
  dots.forEach((dot, i) => {
    dot.classList.toggle('active', i === active);
  });
}

// Create dots
const dotsContainer = document.getElementById('carousel-dots');
for (let i = 0; i < totalSlides; i++) {
  const dot = document.createElement('div');
  dot.className = `carousel-dot ${i === 0 ? 'active' : ''}`;
  dot.onclick = () => {
    currentSlide = i;
    showSlide(i);
  };
  dotsContainer.appendChild(dot);
}

// Auto-advance carousel every 6 seconds
setInterval(() => {
  moveCarousel(1);
}, 6000);

// Keyboard navigation
document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') moveCarousel(-1);
  if (e.key === 'ArrowRight') moveCarousel(1);
});
