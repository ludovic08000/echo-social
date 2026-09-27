-- The PGMQ wrappers are SECURITY DEFINER because the Edge Functions cannot
-- access the pgmq schema directly. PostgreSQL grants EXECUTE to PUBLIC when a
-- function is created, so every recreation must explicitly restore the
-- server-only boundary.

REVOKE EXECUTE ON FUNCTION public.enqueue_email(TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_email(TEXT, JSONB)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.read_email_batch(TEXT, INT, INT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_email_batch(TEXT, INT, INT)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.delete_email(TEXT, BIGINT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_email(TEXT, BIGINT)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.move_to_dlq(TEXT, TEXT, BIGINT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.move_to_dlq(TEXT, TEXT, BIGINT, JSONB)
  TO service_role;
