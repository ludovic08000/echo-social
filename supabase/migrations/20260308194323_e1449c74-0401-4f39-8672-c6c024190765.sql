-- Fix cart quantity validation for products without explicit stock
-- Business rule: if stock_quantity is NULL, default max in cart is 1 (first come, first served)

CREATE OR REPLACE FUNCTION public.validate_cart_item_quantity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_stock integer;
  v_is_active boolean;
  v_max_quantity integer;
BEGIN
  IF NEW.quantity IS NULL OR NEW.quantity <= 0 THEN
    RAISE EXCEPTION 'Invalid quantity';
  END IF;

  SELECT stock_quantity, is_active
  INTO v_stock, v_is_active
  FROM public.products
  WHERE id = NEW.product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found';
  END IF;

  IF v_is_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Product is not available';
  END IF;

  -- Critical change: NULL stock now defaults to 1 (was 10)
  v_max_quantity := COALESCE(v_stock, 1);

  IF NEW.quantity > v_max_quantity THEN
    RAISE EXCEPTION 'Quantity exceeds allowed limit';
  END IF;

  RETURN NEW;
END;
$function$;

-- Normalize existing cart rows that exceed allowed max after this rule change
UPDATE public.cart_items ci
SET quantity = LEAST(
  ci.quantity,
  COALESCE((SELECT p.stock_quantity FROM public.products p WHERE p.id = ci.product_id), 1)
)
WHERE ci.quantity > COALESCE((SELECT p.stock_quantity FROM public.products p WHERE p.id = ci.product_id), 1);