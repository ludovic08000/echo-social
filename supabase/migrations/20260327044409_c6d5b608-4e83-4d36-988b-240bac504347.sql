
DO $outer$
BEGIN
  PERFORM cron.schedule(
    'cleanup-rate-limits',
    '*/10 * * * *',
    'DELETE FROM public.rate_limits WHERE window_start < now() - interval ''10 minutes'''
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not available for rate_limits cleanup';
END;
$outer$;
