// Script para crear la tabla de historial de estados de pedidos
const { pool } = require('../config/db');

async function createHistorialTable() {
    const connection = await pool.getConnection();
    
    try {
        console.log('Creando tabla historial_estado_pedido...');
        
        await connection.query(`
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
        
        console.log('✅ Tabla historial_estado_pedido creada correctamente');
        
        // Verificar que se creó
        const [rows] = await connection.query(`
            SELECT COUNT(*) as count FROM information_schema.tables 
            WHERE table_schema = DATABASE() 
            AND table_name = 'historial_estado_pedido'
        `);
        
        if (rows[0].count === 1) {
            console.log('✅ Verificación exitosa - Tabla existe en la base de datos');
        }
        
    } catch (error) {
        console.error('❌ Error al crear tabla:', error);
        throw error;
    } finally {
        connection.release();
    }
}

createHistorialTable()
    .then(async () => {
        console.log('Script finalizado con éxito');
        await pool.end();
        process.exit(0);
    })
    .catch(async (error) => {
        console.error('Script falló:', error);
        await pool.end();
        process.exit(1);
    });
