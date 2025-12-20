-- Tabla para historial de cambios de estado de pedidos
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
) ENGINE=InnoDB;
