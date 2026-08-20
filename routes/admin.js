
const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const { pool } = require('../config/db');
const bcrypt = require('bcryptjs');
const requireAuth = require('../middleware/requireAuth');
const uploadsStorage = require('../services/uploads-storage');
const orderPhotoRetention = require('../services/order-photo-retention');
const { csrfProtection, generateCsrfToken } = require('../middleware/csrf');
const { loginLimiter } = require('../middleware/rateLimiters');
const { requireSameOrigin } = require('../middleware/sameOrigin');
const { verifyAdminPassword } = require('../services/adminAuth');
const { getTransporter, getFromAddress } = require('../services/mailer');
const { buildStatusChangeEmail } = require('../services/order-emails');
const { SUPPORT_INFO } = require('../services/email-template');
const checkoutDrafts = require('../services/checkout-drafts');
const { normalizeLocale } = require('../config/locales');

// POST /admin/variantes - Crear nueva opción de variante (base o forma)
router.post('/variantes', requireAuth, csrfProtection, async (req, res) => {
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
// Same-origin (hardening final, sección 12-14): primer filtro, antes incluso
// del rate limiter -- una petición que no puede demostrar same-origin (vía
// Origin, o Referer si Origin está ausente) se rechaza sin gastar cuota de
// rate limit ni tocar la BD.
// Rate limit (sección 21): pocos intentos/IP en la ventana para dificultar
// brute force sin bloquear a un admin real que se equivoca alguna vez
// (skipSuccessfulRequests: los logins correctos no cuentan).
// CSRF (sección 17, decisión A/B): este endpoint NO exige token CSRF porque
// todavía no existe sesión admin de la que depender -- la defensa aquí es
// same-origin + sameSite=lax (server.js) + rate limit + mensaje de error
// genérico. Same-origin NO sustituye al rate limit, ni al revés (sección 15).
router.post('/login', requireSameOrigin, loginLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email y contraseña requeridos' });
        }

        // Buscar usuario admin
        const query = 'SELECT id, email, nombre, contraseña FROM usuarios WHERE email = ? AND es_admin = 1 LIMIT 1';
        const [rows] = await pool.query(query, [email]);

        // Mensaje idéntico tanto si el email no existe como si la contraseña
        // es incorrecta (sección 9): nunca se revela cuál de las dos falló.
        if (rows.length === 0) {
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }

        const admin = rows[0];
        // Hardening final (sección 1): SOLO se acepta un hash bcrypt real.
        // Ningún fallback a texto plano -- un registro que no es un hash
        // bcrypt válido nunca autentica, se trate como se trate su contenido.
        const { valid: isValid, requiresMigration } = await verifyAdminPassword(password, admin.contraseña);
        if (requiresMigration) {
            // Log técnico genérico: nunca el valor del campo, nunca el hash,
            // nunca la contraseña recibida. Ver scripts/check-admin-password-hashes.js
            // para el chequeo pre-deploy que detecta esto sin intentar loguear.
            console.warn(`[routes/admin] login: el credential record del admin id=${admin.id} no tiene formato de hash bcrypt válido -- requiere migración/reset seguro antes de poder autenticar`);
        }
        if (!isValid) {
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }

        // Session fixation (sección 8): regenerar el ID de sesión ANTES de
        // establecer identidad -- así una sesión anónima previa (o una fijada
        // por un atacante antes del login) nunca queda autenticada.
        req.session.regenerate((regenErr) => {
            if (regenErr) {
                console.error('[routes/admin] login: error regenerando sesión -', regenErr.message);
                return res.status(500).json({ error: 'Error al iniciar sesión' });
            }

            req.session.adminId = admin.id;
            req.session.adminEmail = admin.email;
            req.session.adminName = admin.nombre;
            req.session.csrfToken = generateCsrfToken();

            // Guardado explícito (sección 48) antes de responder: evita la
            // carrera de responder con éxito mientras el store todavía no
            // terminó de persistir la sesión nueva.
            req.session.save((saveErr) => {
                if (saveErr) {
                    console.error('[routes/admin] login: error guardando sesión -', saveErr.message);
                    return res.status(500).json({ error: 'Error al guardar sesión' });
                }
                res.json({ success: true, message: 'Login exitoso' });
            });
        });
    } catch (error) {
        console.error('[routes/admin] login: error -', error.message);
        res.status(500).json({ error: 'Error al procesar login' });
    }
});

// GET /admin/api/csrf-token - Entrega el token CSRF de la sesión admin activa
// (sección 15/46). El frontend lo pide tras login/recarga y lo reenvía en
// X-CSRF-Token en cada mutación (ver public/js/admin-fetch.js).
router.get('/api/csrf-token', requireAuth, (req, res) => {
    if (!req.session.csrfToken) {
        req.session.csrfToken = generateCsrfToken();
    }
    req.session.save((err) => {
        if (err) {
            console.error('[routes/admin] csrf-token: error guardando sesión -', err.message);
            return res.status(500).json({ error: 'Error interno' });
        }
        res.json({ csrfToken: req.session.csrfToken });
    });
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
router.post('/account', requireAuth, csrfProtection, async (req, res) => {
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

        // Verificar contraseña actual (hardening final, sección 1): mismo
        // camino que el login -- solo bcrypt real, nunca fallback a texto plano.
        const { valid, requiresMigration } = await verifyAdminPassword(currentPassword, admin.contraseña);
        if (requiresMigration) {
            console.warn(`[routes/admin] account: el credential record del admin id=${admin.id} no tiene formato de hash bcrypt válido -- requiere migración/reset seguro`);
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
                COALESCE(p.customer_name, u.nombre, 'Sin nombre') as customer_name,
                p.customer_email as email
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
router.put('/pedidos/:id/estado', requireAuth, csrfProtection, async (req, res) => {
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

        // Obtener información del pedido incluyendo estado actual.
        // p.stripe_payment_intent_id (informe "persistir locale del
        // comprador"): permite recuperar más abajo el draft/snapshot
        // original del pedido -- y con él, customerData.locale -- aunque
        // este cambio de estado ocurra días después del pago.
        const orderQuery = `
                 SELECT p.id, p.usuario_id, p.estado_id, p.stripe_payment_intent_id,
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

            // Enviar email notificando cambio de estado si hay email del cliente.
            // Locale (informe "persistir locale del comprador"): se recupera
            // del draft original vía stripe_payment_intent_id -- el draft
            // nunca se borra al convertirse en pedido, solo cambia de status
            // -- NUNCA se infiere de customer_country (CH es DE/FR/IT).
            // Pedidos legacy sin stripe_payment_intent_id, o sin draft/locale
            // recuperable, caen a 'es' (normalizeLocale tolera undefined).
            if (order.email) {
                const draft = await checkoutDrafts.getDraftByPaymentIntentId(order.stripe_payment_intent_id, { pool });
                const locale = normalizeLocale(draft?.snapshot?.customerData?.locale);
                sendStatusChangeEmail(order.id, order.email, order.nombre, estado, locale);
            }
        }

        // P1 Admin Pedidos/Fotos/Retención: borrado de fotos del cliente
        // ÚNICAMENTE cuando el estado OBJETIVO (nombre real, ya validado
        // contra estado_pedido arriba) es "Entregado" -- nunca en ningún
        // otro estado. El pedido YA quedó confirmado como Entregado (o ya
        // lo estaba) antes de este paso: filesystem y MySQL no comparten
        // transacción, así que el cambio de estado nunca depende de que el
        // borrado de fotos tenga éxito. Se dispara también si el pedido YA
        // estaba Entregado (fuera del `if` de arriba a propósito): permite
        // reintentar de forma segura un cleanup previamente fallido
        // volviendo a guardar el mismo estado, sin reprocesar las imágenes
        // ya marcadas DELETED (ver services/order-photo-retention.js).
        let photoCleanup = null;
        if (estado === 'Entregado') {
            photoCleanup = await orderPhotoRetention.deleteOrderCustomerUploads(id, { pool });
        }

        res.json({ success: true, message: 'Estado actualizado', orderId: id, newStatus: estado, photoCleanup });
    } catch (error) {
        console.error('❌ Error al actualizar estado:', error);
        res.status(500).json({ error: 'Error al actualizar estado' });
    }
});

// GET /admin/pedidos/:id/detalle - Obtener líneas del pedido
router.get('/pedidos/:id/detalle', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;

        // Cabecera del pedido. customer_email/phone/address/city/zip/country
        // vienen EXCLUSIVAMENTE de la propia fila de `pedidos` (los datos de
        // contacto/envío usados AL COMPRAR ese pedido) -- nunca de
        // `usuarios`, a diferencia de customer_name arriba (que sí conserva
        // su fallback histórico a la cuenta, sin cambios en esta tarea): si
        // el cliente cambia el email/teléfono de su cuenta después, este
        // pedido debe seguir mostrando los datos de contacto reales con los
        // que se compró. Funciona igual para usuario registrado, guest o
        // usuario_id NULL, porque nunca se hace JOIN con `usuarios` para
        // estos campos.
        const [orders] = await pool.query(`
                 SELECT p.id, p.total, p.currency, p.created_at, ep.nombre AS estado_nombre,
                     COALESCE(p.customer_name, u.nombre, 'Sin nombre') AS customer_name,
                     p.customer_email AS email, p.customer_phone AS phone,
                     p.customer_address, p.customer_city, p.customer_zip, p.customer_country
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

        // Obtener imágenes por cada línea. P0-FOTOS-01: el frontend admin
        // NUNCA recibe la `ruta` interna (ni la antigua URL pública ni la
        // nueva key) -- solo {id, deleted, viewUrl}. Para una imagen ya
        // borrada por P1 Admin Pedidos/Fotos/Retención (ruta ===
        // DELETED_IMAGE_SENTINEL tras marcar "Entregado"), viewUrl es
        // SIEMPRE null: la ruta autenticada de abajo respondería 404 igual
        // (resolveAdminImageReference rechaza el sentinel), pero no tiene
        // sentido ofrecer un enlace que se sabe roto de antemano.
        for (const item of items) {
            const [images] = await pool.query(
                'SELECT id, ruta FROM detalle_pedido_imagenes WHERE detalle_pedido_id = ?',
                [item.id]
            );
            item.imagenes = images.map(img => {
                const deleted = orderPhotoRetention.isDeletedImageRuta(img.ruta);
                return {
                    id: img.id,
                    deleted,
                    viewUrl: deleted ? null : `/admin/pedidos/${id}/imagenes/${img.id}`
                };
            });
        }

        res.json({ order: orders[0], items });
    } catch (error) {
        console.error('❌ Error al obtener detalle del pedido:', error.message);
        res.status(500).json({ error: 'Error al obtener detalle' });
    }
});

// GET /admin/pedidos/:orderId/imagenes/:imageId - Sirve una fotografía de
// personalización del cliente (P0-FOTOS-01). Única vía oficial para las
// fotos subidas en la web: sesión admin válida (requireAuth) + la imagen
// debe pertenecer REALMENTE a ese pedido (JOIN, no solo "el imageId
// existe"). NUNCA acepta un path arbitrario -- ver
// services/uploads-storage.js#resolveAdminImageReference/resolveCustomUploadPath.
router.get('/pedidos/:orderId/imagenes/:imageId', requireAuth, async (req, res) => {
    try {
        const { orderId, imageId } = req.params;

        const [rows] = await pool.query(
            `SELECT dpi.ruta
             FROM detalle_pedido_imagenes dpi
             JOIN detalle_pedidos dp ON dpi.detalle_pedido_id = dp.id
             WHERE dpi.id = ? AND dp.pedido_id = ?
             LIMIT 1`,
            [imageId, orderId]
        );
        if (rows.length === 0) {
            // No distingue "imagen inexistente" de "existe pero es de otro
            // pedido": ambos son simplemente "no autorizado para esta
            // combinación pedido+imagen" (sección 15/30).
            return res.status(404).end();
        }

        const resolved = uploadsStorage.resolveAdminImageReference(rows[0].ruta);
        if (!resolved.ok) {
            if (resolved.reason === 'external') {
                // Referencia legacy con forma de URL externa: nunca se hace
                // fetch server-side de ella (sección 29, SSRF). Como el
                // caller ya es un admin autenticado sobre SU pedido, un
                // mensaje explícito es más útil que un 404 genérico.
                return res.status(422).json({ error: 'Referencia de imagen legacy no soportada (URL externa)' });
            }
            return res.status(404).end();
        }

        const resolvedPath = await uploadsStorage.resolveCustomUploadPath(resolved.filename);
        if (!resolvedPath) {
            return res.status(404).end();
        }
        const contentType = uploadsStorage.contentTypeForFilename(resolved.filename);
        if (!contentType) {
            return res.status(404).end();
        }

        res.set({
            'Content-Type': contentType,
            'Content-Disposition': 'inline',
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff'
        });
        // resolvedPath ya es absoluto y validado (ver routes/uploads.js para
        // la misma nota): no se combina con {root}.
        res.sendFile(resolvedPath, (err) => {
            if (err && !res.headersSent) {
                res.status(404).end();
            }
        });
    } catch (error) {
        console.error('❌ Error al servir imagen de pedido:', error.message);
        if (!res.headersSent) res.status(500).json({ error: 'Error al obtener la imagen' });
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

// POST /admin/logout - Cerrar sesión (sección 10/18/47)
// requireAuth+CSRF: cerrar sesión es una mutación de estado autenticado, así
// que exige lo mismo que cualquier otra -- nadie puede desloguear a un admin
// simplemente haciéndole cargar una imagen/link externo desde otro origen.
router.post('/logout', requireAuth, csrfProtection, (req, res) => {
    const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: req.session.cookie.secure, path: '/' };
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: 'Error al cerrar sesión' });
        }
        // Limpieza explícita de la cookie en el navegador (sección 10): destroy()
        // ya invalida la sesión server-side, pero clearCookie fuerza además su
        // expiración en el cliente con las mismas opciones con las que se emitió.
        res.clearCookie('connect.sid', cookieOptions);
        res.json({ success: true });
    });
});

// Función para enviar email de cambio de estado. Plantilla unificada (ver
// services/order-emails.js#buildStatusChangeEmail + services/email-template.js):
// mismo logo/colores reales de LITUM3D y el mismo footer/soporte que el
// resto de emails, en vez del degradado azul/morado genérico anterior sin
// relación con la identidad visual del sitio.
//
// getTransporter() se llama AQUÍ DENTRO (no una sola vez al cargar el
// módulo): scripts/check-admin-order-photos-retention.js intercepta
// nodemailer sustituyendo require.cache['nodemailer'] DESPUÉS de cargar
// este router, así que el require perezoso (dentro de services/mailer.js)
// es lo que permite que el fake se aplique a cada envío real de este test.
async function sendStatusChangeEmail(orderId, customerEmail, customerName, newStatus, locale = 'es') {
    const transporter = getTransporter();

    // locale ya viene normalizado (es/de/fr) por el llamante -- ver el
    // handler PUT /pedidos/:id/estado más arriba, que lo recupera del draft
    // original vía stripe_payment_intent_id. buildStatusChangeEmail
    // normaliza de nuevo internamente, así que un valor ausente/corrupto
    // sigue cayendo a 'es' sin lanzar.
    const { subject, html, text } = buildStatusChangeEmail({ locale, orderId, customerName, newStatus });

    const mailOptions = {
        from: getFromAddress(),
        to: customerEmail,
        replyTo: SUPPORT_INFO.email,
        subject,
        html,
        text
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`✓ Email de actualización enviado a ${customerEmail}`);
    } catch (error) {
        console.error(`❌ Error al enviar email de actualización:`, error);
    }
}

// POST /admin/migrate/historial - Crear tabla historial_estado_pedido (solo para desarrollo)
router.post('/migrate/historial', requireAuth, csrfProtection, async (req, res) => {
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
router.post('/productos', requireAuth, csrfProtection, async (req, res) => {
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
router.put('/productos/:id', requireAuth, csrfProtection, async (req, res) => {
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
router.delete('/productos/:id', requireAuth, csrfProtection, async (req, res) => {
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
router.post('/productos/:id/modelos', requireAuth, csrfProtection, async (req, res) => {
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
router.put('/productos/:productId/modelos/:modelId', requireAuth, csrfProtection, async (req, res) => {
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
router.delete('/productos/:productId/modelos/:modelId', requireAuth, csrfProtection, async (req, res) => {
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
