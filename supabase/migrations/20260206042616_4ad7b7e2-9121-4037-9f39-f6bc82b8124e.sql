
-- Add education fields to profiles table
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS education_level text,
ADD COLUMN IF NOT EXISTS education_city text;
