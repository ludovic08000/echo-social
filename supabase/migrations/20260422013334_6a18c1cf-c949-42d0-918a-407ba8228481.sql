-- Crypto error logs (immutable diagnostic trail for encryption failures)
CREATE TABLE public.crypto_error_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  severity TEXT NOT NULL DEFAULT 'error' CHECK (severity IN ('info','warning','error','critical')),
  context TEXT NOT NULL,
  error_code TEXT NOT NULL,
  error_message TEXT NOT NULL,
  conversation_id UUID NULL,
  my_device_id TEXT NULL,
  peer_user_id UUID NULL,
  peer_device_id TEXT NULL,
  stack TEXT NULL,
  user_agent TEXT NULL,
  metadata JSONB NULL
);

CREATE INDEX idx_crypto_error_logs_user ON public.crypto_error_logs(user_id, created_at DESC);
CREATE INDEX idx_crypto_error_logs_conv ON public.crypto_error_logs(conversation_id, created_at DESC);
CREATE INDEX idx_crypto_error_logs_code ON public.crypto_error_logs(error_code, created_at DESC);
CREATE INDEX idx_crypto_error_logs_severity ON public.crypto_error_logs(severity, created_at DESC);

ALTER TABLE public.crypto_error_logs ENABLE ROW LEVEL SECURITY;

-- Users: see + insert their own
CREATE POLICY "Users view own crypto logs"
ON public.crypto_error_logs
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Users insert own crypto logs"
ON public.crypto_error_logs
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

-- Admins: full read + delete (purge), no update (immutable)
CREATE POLICY "Admins view all crypto logs"
ON public.crypto_error_logs
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY "Admins delete crypto logs"
ON public.crypto_error_logs
FOR DELETE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::public.app_role));

-- Auto-purge logs older than 30 days (called from existing cleanup cron if any)
CREATE OR REPLACE FUNCTION public.purge_old_crypto_error_logs()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.crypto_error_logs
  WHERE created_at < now() - INTERVAL '30 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;