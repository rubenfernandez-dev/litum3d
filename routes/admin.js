
const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const { pool } = require('../config/db');
const bcrypt = require('bcryptjs');
const requireAuth = require('../middleware/requireAuth');

// POST /admin/variantes - Crear nueva opción de variante (base o forma)
router.post('/variantes', requireAuth, async (req, res) => {
    try {
        const { tipo, nombre, price_delta = 0, stock = 100, product_id } = req.body;
        console.log('📝 Guardando variante:', { tipo, nombre, price_delta, stock, product_id });
        
        if (!tipo || !nombre) {
            console.error('❌ Faltan campos: tipo o nombre');
            return res.status(400).json({ error: 'Tipo y nombre son obligatorios' });
        }
        
        // Validar que el stock sea válido
        const validStock = Math.max(1, parseInt(stock) || 100);
        
        // Buscar producto (por seguridad)
        let prodId = product_id;
        if (!prodId) {
            // Si no se envía product_id, usar el primero (o puedes cambiar esta lógica)
            const [prods] = await pool.query('SELECT id FROM productos ORDER BY id ASC LIMIT 1');
            if (!prods.length) {
                console.error('❌ No hay productos disponibles');
                return res.status(400).json({ error: 'No hay productos disponibles' });
            }
            prodId = prods[0].id;
            console.log('✓ Se usó producto por defecto:', prodId);
        }
        console.log('✓ Producto ID:', prodId);
        
        // Buscar o crear el tipo de variante (Base/Forma) para el producto
        let [types] = await pool.query('SELECT id FROM product_variant_types WHERE product_id = ? AND LOWER(nombre) = LOWER(?) LIMIT 1', [prodId, tipo]);
        let typeId;
        if (types.length === 0) {
            // Crear tipo de variante si no existe
            console.log('✓ Creando nuevo tipo de variante:', tipo);
            const [result] = await pool.query('INSERT INTO product_variant_types (product_id, nombre, is_required, display_order) VALUES (?, ?, TRUE, ?)', [prodId, tipo.charAt(0).toUpperCase() + tipo.slice(1).toLowerCase(), tipo.toLowerCase() === 'base' ? 1 : 2]);
            typeId = result.insertId;
            console.log('✓ Tipo de variante creado con ID:', typeId);
        } else {
            typeId = types[0].id;
            console.log('✓ Tipo de variante existe con ID:', typeId);
        }
        
        // Crear la opción de variante con stock especificado
        console.log('✓ Creando opción de variante:', { typeId, nombre, price_delta, stock: validStock });
        const [result2] = await pool.query('INSERT INTO product_variant_options (variant_type_id, nombre, price_delta, stock) VALUES (?, ?, ?, ?)', [typeId, nombre, price_delta, validStock]);
        console.log('✅ Variante guardada exitosamente con ID:', result2.insertId);
        res.json({ success: true, optionId: result2.insertId });
    } catch (error) {
        console.error('❌ Error al crear variante:', error.message);
        console.error('Stack:', error.stack);
        res.status(500).json({ error: 'Error al crear variante', details: error.message });
    }
});



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
        console.log('🔐 Verificando contraseña (bcrypt)...');
        let isValid = false;
        try {
            // Intentar comparar como hash
            isValid = await bcrypt.compare(password, admin.contraseña);
        } catch (e) {
            isValid = false;
        }
        // Fallback: si no es hash, comparar texto plano (para migración)
        if (!isValid) {
            isValid = admin.contraseña === password;
        }
        if (!isValid) {
            console.log('❌ Contraseña incorrecta');
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }

        // Crear sesión
        console.log('✓ Contraseña correcta, creando sesión...');
        req.session.adminId = admin.id;
        req.session.adminEmail = admin.email;
        req.session.adminName = admin.nombre;

        // Forzar guardado de sesión
        req.session.save((err) => {
            if (err) {
                console.error('❌ Error guardando sesión:', err);
                return res.status(500).json({ error: 'Error al guardar sesión' });
            }
            console.log('✅ Login exitoso para:', admin.email, 'Session ID:', req.sessionID);
            res.json({ success: true, message: 'Login exitoso' });
        });
    } catch (error) {
        console.error('❌ Error en login:', error.message);
        console.error('Stack:', error.stack);
        res.status(500).json({ error: 'Error al procesar login' });
    }
});

// GET /admin/account - Página para cambiar email/contraseña
router.get('/account', requireAuth, async (req, res) => {
    try {
        const html = await fs.readFile(path.join(__dirname, '/../views/admin-account.html'), 'utf-8');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (error) {
        console.error('Error cargando account:', error);
        res.status(500).send('Error cargando página de cuenta');
    }
});

// POST /admin/account - Actualizar credenciales del admin
router.post('/account', requireAuth, async (req, res) => {
    try {
        const { currentPassword, newEmail, newPassword } = req.body;

        if (!currentPassword || (!newEmail && !newPassword)) {
            return res.status(400).json({ error: 'Faltan datos: contraseña actual y nuevo email o nueva contraseña' });
        }

        const [rows] = await pool.query('SELECT id, email, contraseña FROM usuarios WHERE id = ? AND es_admin = 1 LIMIT 1', [req.session.adminId]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Admin no encontrado' });
        }
        const admin = rows[0];

        // Verificar contraseña actual
        let valid = false;
        try {
            valid = await bcrypt.compare(currentPassword, admin.contraseña);
        } catch (e) { valid = false; }
        if (!valid) {
            valid = admin.contraseña === currentPassword; // fallback
        }
        if (!valid) {
            return res.status(401).json({ error: 'Contraseña actual incorrecta' });
        }

        const updates = [];
        const params = [];
        if (newEmail) {
            updates.push('email = ?');
            params.push(newEmail);
        }
        if (newPassword) {
            const hash = await bcrypt.hash(newPassword, 10);
            updates.push('contraseña = ?');
            params.push(hash);
        }
        if (updates.length === 0) {
            return res.status(400).json({ error: 'Nada que actualizar' });
        }
        params.push(req.session.adminId);
        const sql = `UPDATE usuarios SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`;
        await pool.query(sql, params);

        if (newEmail) req.session.adminEmail = newEmail;

        res.json({ success: true });
    } catch (error) {
        console.error('❌ Error al actualizar cuenta:', error.message);
        res.status(500).json({ error: 'Error al actualizar cuenta: ' + error.message });
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
                p.currency,
                p.created_at,
                COALESCE(p.customer_name, u.nombre, 'Cliente Anónimo') as customer_name
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
        const { estado, comentario } = req.body;

        if (!estado) {
            return res.status(400).json({ error: 'Estado requerido' });
        }

        // Obtener ID del nuevo estado
        const statusQuery = 'SELECT id FROM estado_pedido WHERE nombre = ? LIMIT 1';
        const [statusRows] = await pool.query(statusQuery, [estado]);

        if (statusRows.length === 0) {
            return res.status(400).json({ error: 'Estado inválido' });
        }

        const nuevoEstadoId = statusRows[0].id;

        // Obtener información del pedido incluyendo estado actual
        const orderQuery = `
                 SELECT p.id, p.usuario_id, p.estado_id,
                     COALESCE(p.customer_email, u.email) AS email,
                     COALESCE(p.customer_name, u.nombre) AS nombre,
                     p.total
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
        const estadoAnteriorId = order.estado_id;

        // Solo actualizar si el estado es diferente
        if (estadoAnteriorId !== nuevoEstadoId) {
            // Registrar en historial
            await pool.query(
                'INSERT INTO historial_estado_pedido (pedido_id, estado_id, admin_id, comentario) VALUES (?, ?, ?, ?)',
                [id, nuevoEstadoId, req.session.adminId, comentario || null]
            );

            // Actualizar estado del pedido
            const updateQuery = 'UPDATE pedidos SET estado_id = ?, updated_at = NOW() WHERE id = ?';
            await pool.query(updateQuery, [nuevoEstadoId, id]);

            // Enviar email notificando cambio de estado si hay email del cliente
            if (order.email) {
                sendStatusChangeEmail(order.id, order.email, order.nombre, estado);
            }
        }

        res.json({ success: true, message: 'Estado actualizado', orderId: id, newStatus: estado });
    } catch (error) {
        console.error('❌ Error al actualizar estado:', error);
        res.status(500).json({ error: 'Error al actualizar estado' });
    }
});

// GET /admin/pedidos/:id/detalle - Obtener líneas del pedido
router.get('/pedidos/:id/detalle', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;

        // Cabecera del pedido
        const [orders] = await pool.query(`
                 SELECT p.id, p.total, p.currency, p.created_at, ep.nombre AS estado_nombre,
                     COALESCE(p.customer_name, u.nombre, 'Cliente Anónimo') AS customer_name,
                     COALESCE(p.customer_email, u.email) AS email
            FROM pedidos p
            JOIN estado_pedido ep ON p.estado_id = ep.id
            LEFT JOIN usuarios u ON p.usuario_id = u.id
            WHERE p.id = ?
            LIMIT 1
        `, [id]);

        if (orders.length === 0) {
            return res.status(404).json({ error: 'Pedido no encontrado' });
        }

        // Líneas del pedido con modelo y notas
        const [items] = await pool.query(`
            SELECT dp.id, dp.cantidad, dp.precio_unitario, (dp.cantidad * dp.precio_unitario) AS subtotal,
                   dp.personalizacion_notas,
                   prod.id AS producto_id, prod.nombre AS producto_nombre, prod.imagen,
                   pm.id AS modelo_id, pm.nombre AS modelo_nombre, pm.sku AS modelo_sku
            FROM detalle_pedidos dp
            JOIN productos prod ON dp.producto_id = prod.id
            LEFT JOIN product_models pm ON dp.modelo_id = pm.id
            WHERE dp.pedido_id = ?
            ORDER BY dp.id ASC
        `, [id]);

        // Obtener imágenes por cada línea
        for (const item of items) {
            const [images] = await pool.query(
                'SELECT id, ruta FROM detalle_pedido_imagenes WHERE detalle_pedido_id = ?',
                [item.id]
            );
            item.imagenes = images;
        }

        res.json({ order: orders[0], items });
    } catch (error) {
        console.error('❌ Error al obtener detalle del pedido:', error.message);
        res.status(500).json({ error: 'Error al obtener detalle' });
    }
});

// GET /admin/pedidos/:id/historial - Obtener historial de cambios de estado
router.get('/pedidos/:id/historial', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;

        const [history] = await pool.query(`
            SELECT 
                h.id,
                h.pedido_id,
                ep.nombre AS estado_nombre,
                COALESCE(u.nombre, 'Sistema') AS admin_nombre,
                h.comentario,
                h.created_at
            FROM historial_estado_pedido h
            JOIN estado_pedido ep ON h.estado_id = ep.id
            LEFT JOIN usuarios u ON h.admin_id = u.id
            WHERE h.pedido_id = ?
            ORDER BY h.created_at ASC
        `, [id]);

        res.json({ history });
    } catch (error) {
        console.error('❌ Error al obtener historial:', error.message);
        res.status(500).json({ error: 'Error al obtener historial' });
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

// POST /admin/migrate/historial - Crear tabla historial_estado_pedido (solo para desarrollo)
router.post('/migrate/historial', requireAuth, async (req, res) => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS historial_estado_pedido (
              id INT PRIMARY KEY AUTO_INCREMENT,
              pedido_id INT NOT NULL,
              estado_id INT NOT NULL,
              admin_id INT,
              comentario TEXT,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE,
              FOREIGN KEY (estado_id) REFERENCES estado_pedido(id),
              FOREIGN KEY (admin_id) REFERENCES usuarios(id) ON DELETE SET NULL,
              INDEX idx_pedido_id (pedido_id),
              INDEX idx_created_at (created_at)
            ) ENGINE=InnoDB
        `);
        
        res.json({ success: true, message: 'Tabla historial_estado_pedido creada correctamente' });
    } catch (error) {
        console.error('Error creando tabla historial:', error);
        res.status(500).json({ error: 'Error al crear tabla' });
    }
});

// GET /admin/products - Página de gestión de productos
router.get('/products', requireAuth, async (req, res) => {
    try {
        const html = await fs.readFile(path.join(__dirname, '/../views/admin-products.html'), 'utf-8');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (error) {
        console.error('Error cargando página de productos:', error);
        res.status(500).send('Error cargando página');
    }
});

// GET /admin/productos - Listar todos los productos
router.get('/productos', requireAuth, async (req, res) => {
    try {
        const [productos] = await pool.query(`
            SELECT id, nombre, descripcion, precio, stock, imagen, created_at, updated_at
            FROM productos
            ORDER BY created_at DESC
        `);
        
        res.json({ success: true, productos });
    } catch (error) {
        console.error('Error al obtener productos:', error);
        res.status(500).json({ error: 'Error al obtener productos' });
    }
});

// POST /admin/productos - Crear nuevo producto
router.post('/productos', requireAuth, async (req, res) => {
    try {
        const { nombre, descripcion, precio, stock, imagen } = req.body;

        if (!nombre || precio === undefined || stock === undefined) {
            return res.status(400).json({ error: 'Nombre, precio y stock son obligatorios' });
        }

        const [result] = await pool.query(
            'INSERT INTO productos (nombre, descripcion, precio, stock, imagen) VALUES (?, ?, ?, ?, ?)',
            [nombre, descripcion || null, precio, stock, imagen || null]
        );

        res.json({ success: true, message: 'Producto creado', productoId: result.insertId });
    } catch (error) {
        console.error('Error al crear producto:', error);
        res.status(500).json({ error: 'Error al crear producto' });
    }
});

// PUT /admin/productos/:id - Actualizar producto
router.put('/productos/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, descripcion, precio, stock, imagen } = req.body;

        if (!nombre || precio === undefined || stock === undefined) {
            return res.status(400).json({ error: 'Nombre, precio y stock son obligatorios' });
        }

        await pool.query(
            'UPDATE productos SET nombre = ?, descripcion = ?, precio = ?, stock = ?, imagen = ?, updated_at = NOW() WHERE id = ?',
            [nombre, descripcion || null, precio, stock, imagen || null, id]
        );

        res.json({ success: true, message: 'Producto actualizado' });
    } catch (error) {
        console.error('Error al actualizar producto:', error);
        res.status(500).json({ error: 'Error al actualizar producto' });
    }
});

// DELETE /admin/productos/:id - Eliminar producto
router.delete('/productos/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM productos WHERE id = ?', [id]);
        res.json({ success: true, message: 'Producto eliminado' });
    } catch (error) {
        console.error('Error al eliminar producto:', error);
        res.status(500).json({ error: 'Error al eliminar producto' });
    }
});

// GET /admin/productos/:id/modelos - Listar modelos de un producto
router.get('/productos/:id/modelos', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await pool.query(
            `SELECT id, product_id, nombre, sku, price_delta, stock, imagen, is_default, activo, created_at, updated_at
             FROM product_models
             WHERE product_id = ?
             ORDER BY is_default DESC, nombre ASC`,
            [id]
        );
        res.json({ success: true, modelos: rows });
    } catch (error) {
        console.error('Error al obtener modelos:', error);
        res.status(500).json({ error: 'Error al obtener modelos' });
    }
});

// POST /admin/productos/:id/modelos - Crear modelo
router.post('/productos/:id/modelos', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, sku, price_delta, stock, imagen, is_default } = req.body || {};

        if (!nombre) {
            return res.status(400).json({ error: 'Nombre requerido' });
        }

        // Asegurar producto existe
        const [productExists] = await pool.query('SELECT id FROM productos WHERE id = ? LIMIT 1', [id]);
        if (productExists.length === 0) {
            return res.status(404).json({ error: 'Producto no encontrado' });
        }

        // Si se marca como default, desmarcar otros
        if (is_default) {
            await pool.query('UPDATE product_models SET is_default = FALSE WHERE product_id = ?', [id]);
        }

        const [result] = await pool.query(
            `INSERT INTO product_models (product_id, nombre, sku, price_delta, stock, imagen, is_default)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [id, nombre, sku || null, price_delta || 0, stock || 0, imagen || null, !!is_default]
        );

        res.json({ success: true, modeloId: result.insertId });
    } catch (error) {
        console.error('Error al crear modelo:', error);
        res.status(500).json({ error: 'Error al crear modelo' });
    }
});

// PUT /admin/productos/:productId/modelos/:modelId - Actualizar modelo
router.put('/productos/:productId/modelos/:modelId', requireAuth, async (req, res) => {
    try {
        const { productId, modelId } = req.params;
        const { nombre, sku, price_delta, stock, imagen, is_default, activo } = req.body || {};

        // Validar existencia
        const [modelRows] = await pool.query('SELECT id FROM product_models WHERE id = ? AND product_id = ? LIMIT 1', [modelId, productId]);
        if (modelRows.length === 0) {
            return res.status(404).json({ error: 'Modelo no encontrado' });
        }

        if (is_default) {
            await pool.query('UPDATE product_models SET is_default = FALSE WHERE product_id = ?', [productId]);
        }

        const fields = [];
        const values = [];
        if (nombre !== undefined) { fields.push('nombre = ?'); values.push(nombre); }
        if (sku !== undefined) { fields.push('sku = ?'); values.push(sku || null); }
        if (price_delta !== undefined) { fields.push('price_delta = ?'); values.push(price_delta || 0); }
        if (stock !== undefined) { fields.push('stock = ?'); values.push(stock || 0); }
        if (imagen !== undefined) { fields.push('imagen = ?'); values.push(imagen || null); }
        if (is_default !== undefined) { fields.push('is_default = ?'); values.push(!!is_default); }
        if (activo !== undefined) { fields.push('activo = ?'); values.push(!!activo); }

        if (!fields.length) {
            return res.status(400).json({ error: 'Nada que actualizar' });
        }

        values.push(modelId, productId);

        await pool.query(
            `UPDATE product_models SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ? AND product_id = ?`,
            values
        );

        res.json({ success: true });
    } catch (error) {
        console.error('Error al actualizar modelo:', error);
        res.status(500).json({ error: 'Error al actualizar modelo' });
    }
});

// DELETE /admin/productos/:productId/modelos/:modelId - Desactivar modelo
router.delete('/productos/:productId/modelos/:modelId', requireAuth, async (req, res) => {
    try {
        const { productId, modelId } = req.params;
        const [result] = await pool.query(
            'UPDATE product_models SET activo = FALSE, updated_at = NOW() WHERE id = ? AND product_id = ?',
            [modelId, productId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Modelo no encontrado' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error al desactivar modelo:', error);
        res.status(500).json({ error: 'Error al desactivar modelo' });
    }
});

module.exports = router;
