ALTER TABLE pedidos
  ADD COLUMN customer_name VARCHAR(150),
  ADD COLUMN customer_email VARCHAR(150),
  ADD COLUMN customer_phone VARCHAR(30),
  ADD COLUMN customer_address VARCHAR(255),
  ADD COLUMN customer_city VARCHAR(120),
  ADD COLUMN customer_zip VARCHAR(20),
  ADD COLUMN customer_country VARCHAR(10);
