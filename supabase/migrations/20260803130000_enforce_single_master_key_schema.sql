-- Aegis accepts one Master Key envelope schema only. Old backups are
-- intentionally discarded: this project is not preserving pre-production data.
DELETE FROM public.user_backups
WHERE version IS DISTINCT FROM 7;

ALTER TABLE public.user_backups
  ALTER COLUMN version SET DEFAULT 7;

ALTER TABLE public.user_backups
  DROP CONSTRAINT IF EXISTS user_backups_single_master_key_schema;

ALTER TABLE public.user_backups
  ADD CONSTRAINT user_backups_single_master_key_schema
  CHECK (version = 7);
