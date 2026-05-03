
-- Per-device unique SHA-256 keys
CREATE TABLE IF NOT EXISTS public.device_keys (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  device_hash TEXT NOT NULL,
  device_label TEXT,
  user_agent TEXT,
  ip_address TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','trusted','revoked')),
  verification_token TEXT,
  verification_sent_at TIMESTAMPTZ,
  trusted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS device_keys_user_hash_idx ON public.device_keys(user_id, device_hash);
CREATE INDEX IF NOT EXISTS device_keys_token_idx ON public.device_keys(verification_token) WHERE verification_token IS NOT NULL;

ALTER TABLE public.device_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own device keys" ON public.device_keys
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users update own device keys" ON public.device_keys
  FOR UPDATE USING (auth.uid() = user_id);

-- Login geo alerts log
CREATE TABLE IF NOT EXISTS public.login_alerts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  device_hash TEXT NOT NULL,
  ip_address TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  user_agent TEXT,
  email_sent BOOLEAN NOT NULL DEFAULT false,
  resolved TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS login_alerts_user_idx ON public.login_alerts(user_id, created_at DESC);

ALTER TABLE public.login_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own login alerts" ON public.login_alerts
  FOR SELECT USING (auth.uid() = user_id);
