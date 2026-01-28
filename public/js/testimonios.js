// testimonios.js - Funcionalidad para página de testimonios

let selectedRating = 0;

// Cargar reseñas aprobadas
async function loadReviews() {
    try {
        const response = await fetch('/api/reviews');
        
        if (!response.ok) {
            throw new Error('Error al cargar reseñas');
        }
        
        const reviews = await response.json();
        renderReviews(reviews);
    } catch (error) {
        console.error('Error:', error);
        document.getElementById('reviews-container').innerHTML = `
            <div style="text-align:center; padding:40px; grid-column: 1 / -1; opacity:0.7;">
                ⚠️ Error al cargar reseñas. Por favor, intenta de nuevo más tarde.
            </div>
        `;
    }
}

// Renderizar reseñas
function renderReviews(reviews) {
    const container = document.getElementById('reviews-container');
    
    if (!reviews || reviews.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding:40px; grid-column: 1 / -1; opacity:0.7;">
                📭 Aún no hay reseñas. ¡Sé el primero en dejar una!
            </div>
        `;
        return;
    }
    
    container.innerHTML = reviews.map(review => {
        const stars = '⭐'.repeat(review.rating);
        const date = new Date(review.fecha_creacion).toLocaleDateString('es-ES', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
        
        let imagesHtml = '';
        if (review.imagenes && review.imagenes.length > 0) {
            imagesHtml = `
                <div class="review-images">
                    ${review.imagenes.map((img, idx) => `
                        <img src="${img}" 
                             alt="Foto ${idx + 1} de ${review.nombre}" 
                             class="review-image"
                             onclick="openImageModal('${img}')">
                    `).join('')}
                </div>
            `;
        }
        
        return `
            <div class="review-card">
                <div class="review-header">
                    <div>
                        <div class="review-author">${review.nombre}</div>
                        <div class="review-stars">${stars}</div>
                    </div>
                    <div class="review-date">${date}</div>
                </div>
                <div class="review-comment">${review.comentario}</div>
                ${imagesHtml}
            </div>
        `;
    }).join('');
}

// Abrir imagen en modal (lightbox simple)
function openImageModal(imgSrc) {
    const modal = document.createElement('div');
    modal.className = 'image-modal';
    modal.innerHTML = `
        <div class="image-modal-content">
            <span class="image-modal-close" onclick="this.parentElement.parentElement.remove()">×</span>
            <img src="${imgSrc}" alt="Imagen ampliada">
        </div>
    `;
    modal.onclick = (e) => {
        if (e.target === modal) {
            modal.remove();
        }
    };
    document.body.appendChild(modal);
}

// Sistema de calificación con estrellas
document.addEventListener('DOMContentLoaded', function() {
    const stars = document.querySelectorAll('.star');
    const ratingInput = document.getElementById('rating-input');
    
    stars.forEach(star => {
        star.addEventListener('click', function() {
            selectedRating = parseInt(this.getAttribute('data-rating'));
            ratingInput.value = selectedRating;
            
            // Actualizar visualización
            stars.forEach((s, idx) => {
                if (idx < selectedRating) {
                    s.style.opacity = '1';
                    s.style.transform = 'scale(1.2)';
                } else {
                    s.style.opacity = '0.3';
                    s.style.transform = 'scale(1)';
                }
            });
        });
        
        // Hover effect
        star.addEventListener('mouseenter', function() {
            const rating = parseInt(this.getAttribute('data-rating'));
            stars.forEach((s, idx) => {
                if (idx < rating) {
                    s.style.opacity = '1';
                } else {
                    s.style.opacity = '0.3';
                }
            });
        });
    });
    
    // Reset hover
    document.getElementById('star-rating').addEventListener('mouseleave', function() {
        stars.forEach((s, idx) => {
            if (idx < selectedRating) {
                s.style.opacity = '1';
            } else {
                s.style.opacity = '0.3';
            }
        });
    });
    
    // Preview de fotos al seleccionar
    const photoInput = document.getElementById('review-photos');
    const photoPreview = document.getElementById('photo-preview');
    
    photoInput.addEventListener('change', function(e) {
        photoPreview.innerHTML = '';
        
        if (this.files.length > 5) {
            alert('Máximo 5 fotos permitidas');
            this.value = '';
            return;
        }
        
        Array.from(this.files).forEach((file, idx) => {
            if (file.type.startsWith('image/')) {
                const reader = new FileReader();
                reader.onload = function(e) {
                    const div = document.createElement('div');
                    div.style.cssText = 'position:relative; width:80px; height:80px;';
                    div.innerHTML = `
                        <img src="${e.target.result}" 
                             style="width:100%; height:100%; object-fit:cover; border-radius:8px; border:2px solid var(--gold);">
                    `;
                    photoPreview.appendChild(div);
                };
                reader.readAsDataURL(file);
            }
        });
    });
    
    // Enviar formulario de reseña
    const reviewForm = document.getElementById('review-form');
    const submitBtn = document.getElementById('submit-btn');
    const formStatus = document.getElementById('form-status');
    
    reviewForm.addEventListener('submit', async function(e) {
        e.preventDefault();
        
        if (!selectedRating) {
            formStatus.innerHTML = '<p style="color:#ff6b6b;">⚠️ Por favor, selecciona una calificación</p>';
            return;
        }
        
        const formData = new FormData(this);
        
        // Deshabilitar botón
        submitBtn.disabled = true;
        submitBtn.textContent = 'Enviando...';
        formStatus.innerHTML = '<p style="color:#64c8ff;">📤 Subiendo tu reseña...</p>';
        
        try {
            const response = await fetch('/api/reviews', {
                method: 'POST',
                body: formData
            });
            
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Error al enviar reseña');
            }
            
            const data = await response.json();
            
            // Éxito
            formStatus.innerHTML = `
                <p style="color:#00ff88;">
                    ✅ ¡Gracias por tu reseña!<br>
                    <small>Será publicada tras revisión</small>
                </p>
            `;
            
            // Resetear formulario
            reviewForm.reset();
            photoPreview.innerHTML = '';
            selectedRating = 0;
            stars.forEach(s => {
                s.style.opacity = '0.3';
                s.style.transform = 'scale(1)';
            });
            
            // Scroll arriba suavemente
            window.scrollTo({ top: 0, behavior: 'smooth' });
            
        } catch (error) {
            console.error('Error:', error);
            formStatus.innerHTML = `<p style="color:#ff6b6b;">⚠️ ${error.message}</p>`;
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Enviar Reseña';
        }
    });
    
    // Cargar reseñas al iniciar
    loadReviews();
});
