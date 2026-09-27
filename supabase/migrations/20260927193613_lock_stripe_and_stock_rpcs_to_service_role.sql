-- These mutations are invoked only after Stripe webhook signature validation.
-- They are SECURITY DEFINER helpers and therefore must not retain PostgreSQL's
-- default PUBLIC execution privilege.

REVOKE EXECUTE ON FUNCTION public.stripe_mark_event_processed(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stripe_mark_event_processed(TEXT, TEXT)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.decrement_product_stock(UUID, INT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decrement_product_stock(UUID, INT)
  TO service_role;
