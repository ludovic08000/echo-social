
-- Hide materialized view from API (security fix)
REVOKE ALL ON public.feed_posts_enriched FROM anon, authenticated;

-- Enable pg_cron and pg_net for scheduled refresh
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
