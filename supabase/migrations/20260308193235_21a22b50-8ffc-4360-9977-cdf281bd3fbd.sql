-- Prevent cart spoofing: enforce stock/availability server-side on cart_items writes
CREATE OR REPLACE FUNCTION public.validate_cart_item_quantity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stock integer;
  v_is_active boolean;
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

  IF v_stock IS NOT NULL AND NEW.quantity > v_stock THEN
    RAISE EXCEPTION 'Quantity exceeds stock';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_cart_item_quantity ON public.cart_items;

CREATE TRIGGER trg_validate_cart_item_quantity
BEFORE INSERT OR UPDATE OF quantity, product_id
ON public.cart_items
FOR EACH ROW
EXECUTE FUNCTION public.validate_cart_item_quantity();