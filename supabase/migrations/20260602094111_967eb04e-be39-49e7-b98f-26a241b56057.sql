ALTER TABLE public.user_devices
  ADD COLUMN IF NOT EXISTS crypto_invalid_at timestamptz,
  ADD COLUMN IF NOT EXISTS crypto_invalid_reason text,
  ADD COLUMN IF NOT EXISTS prekey_repair_requested_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_user_devices_crypto_invalid_at
  ON public.user_devices (crypto_invalid_at)
  WHERE crypto_invalid_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_devices_prekey_repair_requested_at
  ON public.user_devices (prekey_repair_requested_at)
  WHERE prekey_repair_requested_at IS NOT NULL;