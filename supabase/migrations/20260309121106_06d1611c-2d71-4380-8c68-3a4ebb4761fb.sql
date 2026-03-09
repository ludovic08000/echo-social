
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS age_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS age_verification_status TEXT NOT NULL DEFAULT 'none';
COMMENT ON COLUMN public.profiles.age_verification_status IS 'none | pending | verified | flagged';
