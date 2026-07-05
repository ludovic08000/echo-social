-- =====================================================================
-- Finalize KT read path + offline ML observability
-- =====================================================================
-- Idempotent migration. It fixes the KT read RPC to match the real
-- e2ee_kt_tree_heads schema (root_hash, not root), exposes the public
-- signing key needed by clients to verify signed tree heads, and records
-- offline/two-tower training runs for operations visibility.

DROP FUNCTION IF EXISTS public.kt_latest_head();

CREATE FUNCTION public.kt_latest_head()
RETURNS TABLE (
  epoch bigint,
  root text,
  leaf_count bigint,
  prev_epoch bigint,
  signing_key_id uuid,
  signature text,
  public_key_jwk jsonb,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    h.epoch,
    h.root_hash AS root,
    h.leaf_count,
    h.prev_epoch,
    h.signing_key_id,
    h.signature,
    k.public_key_jwk,
    h.created_at
  FROM public.e2ee_kt_tree_heads h
  JOIN public.e2ee_kt_signing_keys k
    ON k.id = h.signing_key_id
  ORDER BY h.epoch DESC
  LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.kt_latest_head() TO authenticated;

DROP FUNCTION IF EXISTS public.kt_get_epoch_leaves(bigint);

CREATE FUNCTION public.kt_get_epoch_leaves(p_epoch bigint)
RETURNS TABLE (
  leaf_index bigint,
  leaf_hash text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT l.leaf_index, l.leaf_hash
  FROM public.e2ee_kt_leaves l
  WHERE l.epoch = p_epoch
  ORDER BY l.leaf_index ASC;
$function$;

GRANT EXECUTE ON FUNCTION public.kt_get_epoch_leaves(bigint) TO authenticated;

CREATE TABLE IF NOT EXISTS public.ml_training_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('started', 'completed', 'failed', 'partial')),
  trained_samples integer NOT NULL DEFAULT 0,
  users_updated integer NOT NULL DEFAULT 0,
  posts_updated integer NOT NULL DEFAULT 0,
  avg_loss numeric,
  elapsed_ms integer,
  budget_hit boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_ml_training_runs_job_started
  ON public.ml_training_runs(job_name, started_at DESC);

ALTER TABLE public.ml_training_runs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'ml_training_runs'
      AND policyname = 'ml_training_runs_admin_read'
  ) THEN
    CREATE POLICY "ml_training_runs_admin_read"
      ON public.ml_training_runs FOR SELECT
      USING (has_role(auth.uid(), 'admin'::app_role));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'ml_training_runs'
      AND policyname = 'ml_training_runs_admin_manage'
  ) THEN
    CREATE POLICY "ml_training_runs_admin_manage"
      ON public.ml_training_runs FOR ALL
      USING (has_role(auth.uid(), 'admin'::app_role))
      WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
  END IF;
END $$;

CREATE OR REPLACE VIEW public.ml_offline_training_health
WITH (security_invoker = true) AS
SELECT
  job_name,
  max(started_at) AS last_started_at,
  max(finished_at) FILTER (WHERE status IN ('completed', 'partial')) AS last_success_at,
  count(*) FILTER (WHERE started_at > now() - interval '24 hours') AS runs_24h,
  count(*) FILTER (WHERE status = 'failed' AND started_at > now() - interval '24 hours') AS failures_24h,
  avg(avg_loss) FILTER (WHERE avg_loss IS NOT NULL AND started_at > now() - interval '7 days') AS avg_loss_7d,
  sum(trained_samples) FILTER (WHERE started_at > now() - interval '24 hours') AS trained_samples_24h
FROM public.ml_training_runs
GROUP BY job_name;

REVOKE ALL ON public.ml_offline_training_health FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ml_offline_training_health TO authenticated;
