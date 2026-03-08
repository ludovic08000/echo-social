CREATE OR REPLACE FUNCTION public.validate_cart_item_quantity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- If stock is set, enforce stock; otherwise enforce hard anti-spam cap
  v_max_quantity := COALESCE(v_stock, 10);

  IF NEW.quantity > v_max_quantity THEN
    RAISE EXCEPTION 'Quantity exceeds allowed limit';
  END IF;

  RETURN NEW;
END;
$$;