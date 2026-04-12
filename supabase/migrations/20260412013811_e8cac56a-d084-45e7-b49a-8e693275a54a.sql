ALTER TABLE public.active_calls ADD COLUMN IF NOT EXISTS encrypted_call_key text;

UPDATE public.active_calls
SET encrypted_call_key = e2ee_key
WHERE encrypted_call_key IS NULL
  AND e2ee_key IS NOT NULL;

ALTER TABLE public.active_calls DROP COLUMN IF EXISTS e2ee_key;