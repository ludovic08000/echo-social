DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE order_number LIKE 'TEST-%');
DELETE FROM orders WHERE order_number LIKE 'TEST-%';