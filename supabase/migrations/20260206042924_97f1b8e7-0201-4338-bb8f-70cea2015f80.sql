
-- Add work field and field visibility to profiles
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS work text,
ADD COLUMN IF NOT EXISTS field_visibility jsonb DEFAULT '{"date_of_birth": "public", "city": "public", "education": "public", "work": "public"}'::jsonb;
