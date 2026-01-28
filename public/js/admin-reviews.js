// admin-reviews.js - Gestión de reseñas en admin dashboard

let reviews = [];
let currentReviewId = null;

// Cargar reseñas
async function loadReviews(estado = '') {
    try {
        const url = estado ? `/api/admin/reviews?estado=${estado}` : '/api/admin/reviews';
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error('Error al cargar reseñas');
        }
        
        const data = await response.json();
        reviews = data;
        renderReviews();
    } catch (error) {
        console.error('Error:', error);
        document.getElementById('reviewsContent').innerHTML = `
            <div style="text-align:center; padding:40px; opacity:0.7;">
                ⚠️ Error al cargar reseñas
            </div>
        `;
    }
}

// Renderizar reseñas
function renderReviews() {
    const container = document.getElementById('reviewsContent');
    
    if (!reviews || reviews.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding:40px; opacity:0.7;">
                📭 No hay reseñas ${document.getElementById('reviewStatusFilter').value ? 'con este estado' : ''}
            </div>
        `;
        return;
    }
    
    container.innerHTML = reviews.map(review => {
        const statusColors = {
            'pendiente': '#ffa500',
            'aprobada': '#00ff88',
            'rechazada': '#ff6b6b'
        };
        
        const stars = '⭐'.repeat(review.rating);
        const date = new Date(review.fecha_creacion).toLocaleDateString('es-ES');
        
        let imagesHtml = '';
        if (review.imagenes && review.imagenes.length > 0) {
            imagesHtml = `
                <div style="display:flex; gap:8px; margin-top:12px; flex-wrap:wrap;">
                    ${review.imagenes.map((img, idx) => `
                        <img src="${img}" 
                             alt="Foto ${idx + 1}" 
                             style="width:80px; height:80px; object-fit:cover; border-radius:8px; cursor:pointer; border: 2px solid rgba(255,255,255,0.1);"
                             onclick="window.open('${img}', '_blank')">
                    `).join('')}
                </div>
            `;
        }
        
        return `
            <div style="background: rgba(255,255,255,0.05); border-radius:12px; padding:20px; border: 1px solid rgba(255,255,255,0.1);">
                <div style="display:flex; justify-content:space-between; align-items:start; margin-bottom:12px;">
                    <div>
                        <div style="font-weight:600; font-size:16px; margin-bottom:4px;">${review.nombre}</div>
                        <div style="font-size:14px; opacity:0.7;">${review.email || 'Sin email'}</div>
                        <div style="margin-top:6px;">${stars} (${review.rating}/5)</div>
                    </div>
                    <div style="text-align:right;">
                        <div style="display:inline-block; padding:6px 12px; border-radius:6px; font-size:12px; font-weight:600; background: rgba(${statusColors[review.estado]}, 0.2); color: ${statusColors[review.estado]}; border: 1px solid rgba(${statusColors[review.estado]}, 0.3); margin-bottom:6px;">
                            ${review.estado.toUpperCase()}
                        </div>
                        ${review.destacada ? '<div style="font-size:12px; color:#ffd700; margin-top:4px;">⭐ Destacada</div>' : ''}
                        <div style="font-size:11px; opacity:0.6; margin-top:4px;">${date}</div>
                    </div>
                </div>
                
                <div style="margin:16px 0; line-height:1.6; opacity:0.9;">
                    ${review.comentario}
                </div>
                
                ${imagesHtml}
                
                <div style="display:flex; gap:8px; margin-top:16px; flex-wrap:wrap;">
                    ${review.estado === 'pendiente' ? `
                        <button onclick="approveReview(${review.id})" 
                                style="padding:8px 16px; background:rgba(0,255,136,0.2); color:#00ff88; border:1px solid rgba(0,255,136,0.3); border-radius:6px; cursor:pointer; font-size:13px;">
                            ✅ Aprobar
                        </button>
                        <button onclick="rejectReview(${review.id})" 
                                style="padding:8px 16px; background:rgba(255,107,107,0.2); color:#ff6b6b; border:1px solid rgba(255,107,107,0.3); border-radius:6px; cursor:pointer; font-size:13px;">
                            ❌ Rechazar
                        </button>
                    ` : ''}
                    
                    ${review.estado === 'aprobada' ? `
                        <button onclick="toggleDestacada(${review.id}, ${!review.destacada})" 
                                style="padding:8px 16px; background:rgba(255,215,0,0.2); color:#ffd700; border:1px solid rgba(255,215,0,0.3); border-radius:6px; cursor:pointer; font-size:13px;">
                            ${review.destacada ? '⭐ Quitar destacada' : '⭐ Marcar destacada'}
                        </button>
                    ` : ''}
                    
                    <button onclick="deleteReview(${review.id})" 
                            style="padding:8px 16px; background:rgba(255,68,68,0.2); color:#ff6b6b; border:1px solid rgba(255,68,68,0.3); border-radius:6px; cursor:pointer; font-size:13px;">
                        🗑️ Eliminar
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

// Aprobar reseña
async function approveReview(id) {
    try {
        const response = await fetch(`/api/admin/reviews/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ estado: 'aprobada' })
        });
        
        if (!response.ok) throw new Error('Error al aprobar');
        
        await loadReviews(document.getElementById('reviewStatusFilter').value);
    } catch (error) {
        console.error('Error:', error);
        alert('Error al aprobar la reseña');
    }
}

// Rechazar reseña
async function rejectReview(id) {
    if (!confirm('¿Rechazar esta reseña? No será visible públicamente.')) return;
    
    try {
        const response = await fetch(`/api/admin/reviews/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ estado: 'rechazada' })
        });
        
        if (!response.ok) throw new Error('Error al rechazar');
        
        await loadReviews(document.getElementById('reviewStatusFilter').value);
    } catch (error) {
        console.error('Error:', error);
        alert('Error al rechazar la reseña');
    }
}

// Toggle destacada
async function toggleDestacada(id, destacada) {
    try {
        const response = await fetch(`/api/admin/reviews/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ destacada })
        });
        
        if (!response.ok) throw new Error('Error al actualizar');
        
        await loadReviews(document.getElementById('reviewStatusFilter').value);
    } catch (error) {
        console.error('Error:', error);
        alert('Error al actualizar destacada');
    }
}

// Eliminar reseña
async function deleteReview(id) {
    if (!confirm('¿Eliminar esta reseña permanentemente? Esta acción no se puede deshacer.')) return;
    
    try {
        const response = await fetch(`/api/admin/reviews/${id}`, {
            method: 'DELETE'
        });
        
        if (!response.ok) throw new Error('Error al eliminar');
        
        await loadReviews(document.getElementById('reviewStatusFilter').value);
    } catch (error) {
        console.error('Error:', error);
        alert('Error al eliminar la reseña');
    }
}

// Mostrar modal para crear reseña
function showCreateReviewModal() {
    document.getElementById('createReviewModal').classList.add('show');
}

// Cerrar modal
function closeCreateReviewModal() {
    document.getElementById('createReviewModal').classList.remove('show');
    document.getElementById('createReviewForm').reset();
    document.getElementById('previewImages').innerHTML = '';
}

// Preview de imágenes al seleccionar
document.addEventListener('DOMContentLoaded', function() {
    const fileInput = document.getElementById('reviewPhotos');
    if (fileInput) {
        fileInput.addEventListener('change', function(e) {
            const preview = document.getElementById('previewImages');
            preview.innerHTML = '';
            
            if (this.files.length > 0) {
                Array.from(this.files).forEach((file, idx) => {
                    if (file.type.startsWith('image/')) {
                        const reader = new FileReader();
                        reader.onload = function(e) {
                            const img = document.createElement('img');
                            img.src = e.target.result;
                            img.style.cssText = 'width:80px; height:80px; object-fit:cover; border-radius:8px; margin-right:8px;';
                            preview.appendChild(img);
                        };
                        reader.readAsDataURL(file);
                    }
                });
            }
        });
    }
});

// Crear nueva reseña
async function submitNewReview(e) {
    e.preventDefault();
    
    const formData = new FormData(e.target);
    
    try {
        const submitBtn = e.target.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Subiendo...';
        
        const response = await fetch('/api/admin/reviews', {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Error al crear reseña');
        }
        
        closeCreateReviewModal();
        await loadReviews();
        alert('✅ Reseña creada correctamente');
    } catch (error) {
        console.error('Error:', error);
        alert('Error: ' + error.message);
    } finally {
        const submitBtn = e.target.querySelector('button[type="submit"]');
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Crear Reseña';
        }
    }
}

// Filtrar reseñas
function filterReviews() {
    const estado = document.getElementById('reviewStatusFilter').value;
    loadReviews(estado);
}

// Mostrar sección de reseñas
function showReviewsSection() {
    // Ocultar pedidos, mostrar reseñas
    document.querySelector('.orders-container').style.display = 'none';
    document.getElementById('reviewsSection').style.display = 'block';
    
    // Cargar reseñas
    loadReviews();
}

// Mostrar sección de pedidos (volver)
function showOrdersSection() {
    document.querySelector('.orders-container').style.display = 'block';
    document.getElementById('reviewsSection').style.display = 'none';
}
