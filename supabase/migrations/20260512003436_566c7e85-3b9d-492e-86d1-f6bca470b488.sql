
-- Table de décisions du bouclier IA
CREATE TABLE IF NOT EXISTS public.threat_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint TEXT NOT NULL,
  ip TEXT,
  user_id UUID,
  category TEXT NOT NULL,
  confidence INTEGER NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
  reason TEXT,
  action_taken TEXT NOT NULL CHECK (action_taken IN ('allow','log','penalize','ban')),
  detector TEXT NOT NULL CHECK (detector IN ('regex','ai','hybrid','client')),
  payload_hash TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_threat_decisions_created_at ON public.threat_decisions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_threat_decisions_category ON public.threat_decisions(category);
CREATE INDEX IF NOT EXISTS idx_threat_decisions_ip ON public.threat_decisions(ip);
CREATE INDEX IF NOT EXISTS idx_threat_decisions_action ON public.threat_decisions(action_taken);

ALTER TABLE public.threat_decisions ENABLE ROW LEVEL SECURITY;

-- Lecture admin uniquement
CREATE POLICY "Admins can read threat decisions"
ON public.threat_decisions FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- Aucune écriture client (la fonction edge utilise service_role qui bypass RLS)
CREATE POLICY "No client writes"
ON public.threat_decisions FOR INSERT TO authenticated
WITH CHECK (false);

-- Stats agrégées pour le widget SOC (security definer = lecture sans perms)
CREATE OR REPLACE FUNCTION public.threat_shield_stats(window_minutes INT DEFAULT 60)
RETURNS TABLE (
  total BIGINT,
  banned BIGINT,
  penalized BIGINT,
  logged BIGINT,
  top_category TEXT,
  last_block TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT * FROM public.threat_decisions
    WHERE created_at > now() - (window_minutes || ' minutes')::interval
  ),
  cats AS (
    SELECT category, COUNT(*) AS c FROM base
    WHERE action_taken IN ('ban','penalize')
    GROUP BY category ORDER BY c DESC LIMIT 1
  )
  SELECT
    (SELECT COUNT(*) FROM base),
    (SELECT COUNT(*) FROM base WHERE action_taken = 'ban'),
    (SELECT COUNT(*) FROM base WHERE action_taken = 'penalize'),
    (SELECT COUNT(*) FROM base WHERE action_taken = 'log'),
    (SELECT category FROM cats),
    (SELECT MAX(created_at) FROM base WHERE action_taken IN ('ban','penalize'));
$$;

REVOKE ALL ON FUNCTION public.threat_shield_stats(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.threat_shield_stats(INT) TO authenticated;

-- Purge auto 30 jours
CREATE OR REPLACE FUNCTION public.purge_old_threat_decisions()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.threat_decisions WHERE created_at < now() - INTERVAL '30 days';
$$;
