const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const { pool } = require('../config/db');

// Middleware para verificar autenticación
const requireAuth = (req, res, next) => {
    if (!req.session || !req.session.adminId) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    next();
};

// GET /admin/login - Mostrar página de login
router.get('/login', async (req, res) => {
    if (req.session?.adminId) {
        return res.redirect('/admin/dashboard');
    }
    try {
        const html = await fs.readFile(path.join(__dirname, '/../views/admin-login.html'), 'utf-8');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (error) {
        console.error('Error cargando login:', error);
        res.status(500).send('Error cargando página de login');
    }
});

// POST /admin/login - Procesar login
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        console.log('📝 Intento de login:', { email, password: password ? '***' : 'vacío' });

        if (!email || !password) {
            return res.status(400).json({ error: 'Email y contraseña requeridos' });
        }

        // Buscar usuario admin
        const query = 'SELECT id, email, nombre, contraseña FROM usuarios WHERE email = ? AND es_admin = 1 LIMIT 1';
        console.log('🔍 Buscando usuario admin con email:', email);
        const [rows] = await pool.query(query, [email]);
        console.log('✓ Resultado de búsqueda:', rows.length > 0 ? 'Usuario encontrado' : 'Usuario NO encontrado');

        if (rows.length === 0) {
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }

        const admin = rows[0];
        console.log('👤 Admin encontrado:', admin.nombre);
        console.log('🔐 Verificando contraseña...');
        console.log('   Contraseña guardada:', admin.contraseña);
        console.log('   Contraseña ingresada:', password);
        console.log('   Coinciden:', admin.contraseña === password);

        // Verificar contraseña (simple string match for demo)
        if (admin.contraseña !== password) {
            console.log('❌ Contraseña incorrecta');
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }

        // Crear sesión
        console.log('✓ Contraseña correcta, creando sesión...');
        req.session.adminId = admin.id;
        req.session.adminEmail = admin.email;
        req.session.adminName = admin.nombre;

        console.log('✅ Login exitoso para:', admin.email);
        res.json({ success: true, message: 'Login exitoso' });
    } catch (error) {
        console.error('❌ Error en login:', error.message);
        console.error('Stack:', error.stack);
        res.status(500).json({ error: 'Error al procesar login' });
    }
});

// GET /admin/dashboard - Mostrar dashboard
router.get('/dashboard', requireAuth, async (req, res) => {
    try {
        const html = await fs.readFile(path.join(__dirname, '/../views/admin-dashboard.html'), 'utf-8');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (error) {
        console.error('Error cargando dashboard:', error);
        res.status(500).send('Error cargando panel de administración');
    }
});

// GET /admin/api/dashboard (API) - Obtener datos de pedidos
router.get('/api/dashboard', requireAuth, async (req, res) => {
    try {
        const query = `
            SELECT 
                p.id,
                p.usuario_id,
                p.estado_id,
                ep.nombre as estado_nombre,
                p.total,
                p.created_at,
                COALESCE(u.nombre, 'Cliente Anónimo') as customer_name
            FROM pedidos p
            JOIN estado_pedido ep ON p.estado_id = ep.id
            LEFT JOIN usuarios u ON p.usuario_id = u.id
            ORDER BY p.created_at DESC
            LIMIT 50
        `;
        
        console.log('🔍 Ejecutando query de pedidos...');
        const [orders] = await pool.query(query);
        console.log(`✓ Se obtuvieron ${orders.length} pedidos`);
        res.json({ orders });
    } catch (error) {
        console.error('❌ Error al cargar pedidos:', error.message);
        console.error('Stack:', error.stack);
        res.status(500).json({ error: 'Error al cargar pedidos: ' + error.message });
    }
});

// PUT /admin/pedidos/:id/estado - Actualizar estado
router.put('/pedidos/:id/estado', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { estado } = req.body;

        if (!estado) {
            return res.status(400).json({ error: 'Estado requerido' });
        }

        // Obtener ID del estado
        const statusQuery = 'SELECT id FROM estado_pedido WHERE nombre = ? LIMIT 1';
        const [statusRows] = await pool.query(statusQuery, [estado]);

        if (statusRows.length === 0) {
            return res.status(400).json({ error: 'Estado inválido' });
        }

        const estadoId = statusRows[0].id;

        // Obtener información del pedido
        const orderQuery = `
            SELECT p.id, p.usuario_id, u.email, u.nombre, p.total
            FROM pedidos p
            LEFT JOIN usuarios u ON p.usuario_id = u.id
            WHERE p.id = ?
            LIMIT 1
        `;
        const [orderRows] = await pool.query(orderQuery, [id]);

        if (orderRows.length === 0) {
            return res.status(404).json({ error: 'Pedido no encontrado' });
        }

        const order = orderRows[0];

        // Actualizar estado
        const updateQuery = 'UPDATE pedidos SET estado_id = ?, updated_at = NOW() WHERE id = ?';
        await pool.query(updateQuery, [estadoId, id]);

        // Enviar email notificando cambio de estado si hay email del cliente
        if (order.email) {
            sendStatusChangeEmail(order.id, order.email, order.nombre, estado);
        }

        res.json({ success: true, message: 'Estado actualizado', orderId: id, newStatus: estado });
    } catch (error) {
        console.error('❌ Error al actualizar estado:', error);
        res.status(500).json({ error: 'Error al actualizar estado' });
    }
});

// POST /admin/logout - Cerrar sesión
router.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: 'Error al cerrar sesión' });
        }
        res.json({ success: true });
    });
});

// Función para enviar email de cambio de estado
async function sendStatusChangeEmail(orderId, customerEmail, customerName, newStatus) {
    const nodemailer = require('nodemailer');

    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });

    const statusMessages = {
        'Pendiente': 'Tu pedido está en espera de confirmación',
        'Confirmado': 'Tu pedido ha sido confirmado y comenzaremos a prepararlo',
        'Preparando': 'Tu pedido está siendo preparado en nuestros talleres',
        'Enviado': 'Tu pedido ha sido enviado y está en camino 📦',
        'Entregado': 'Tu pedido ha sido entregado. ¡Gracias por tu compra! ✓',
        'Cancelado': 'Tu pedido ha sido cancelado'
    };

    const mailOptions = {
        from: process.env.SMTP_USER,
        to: customerEmail,
        subject: `Actualización de tu Pedido #${orderId} - LITUM 3D`,
        html: `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
                    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                    .header { background: linear-gradient(135deg, #64c8ff 0%, #9664ff 100%); color: white; padding: 20px; text-align: center; border-radius: 10px 10px 0 0; }
                    .content { background: #f5f5f5; padding: 20px; border-radius: 0 0 10px 10px; }
                    .status-badge { display: inline-block; padding: 10px 20px; border-radius: 20px; font-weight: bold; margin: 20px 0; }
                    .status-preparando { background: rgba(150, 100, 255, 0.2); color: #b366ff; }
                    .status-enviado { background: rgba(100, 255, 150, 0.2); color: #66ff99; }
                    .status-entregado { background: rgba(100, 255, 100, 0.2); color: #66ff66; }
                    .footer { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h1>🔔 Actualización de tu Pedido</h1>
                    </div>
                    <div class="content">
                        <p>¡Hola ${customerName || 'Cliente'}!</p>
                        <p>${statusMessages[newStatus] || 'Tu pedido ha sido actualizado'}</p>
                        <div class="status-badge status-${newStatus.toLowerCase()}">
                            ${newStatus.toUpperCase()}
                        </div>
                        <p><strong>Número de Pedido:</strong> #${orderId}</p>
                        <p>Si tienes preguntas sobre tu pedido, no dudes en contactarnos.</p>
                        <p>¡Gracias por elegir LITUM 3D! 🎨</p>
                    </div>
                    <div class="footer">
                        <p>© 2024 LITUM 3D - Impresión 3D de Calidad</p>
                    </div>
                </div>
            </body>
            </html>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✓ Email de actualización enviado a ${customerEmail}`);
    } catch (error) {
        console.error(`❌ Error al enviar email de actualización:`, error);
    }
}

module.exports = router;
