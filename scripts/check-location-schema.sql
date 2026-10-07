-- Read-only Lovable Cloud SQL editor preflight. No user rows, IPs or secrets are read.
-- Every result must be true before functional staging tests and operator activation.
-- This does NOT prove Edge deployment, gateway header trust or cleanup job execution.
SELECT
  to_regclass('public.discovery_preferences') IS NOT NULL AS discovery_ready,
  to_regclass('public.ad_location_contexts') IS NOT NULL AS ad_cache_ready,
  to_regclass('public.media_partners') IS NOT NULL AS media_ready,
  to_regprocedure('public.get_my_ad_location_context()') IS NOT NULL AS ad_rpc_ready,
  to_regprocedure('public.cleanup_discovery_data()') IS NOT NULL AS cleanup_ready;
