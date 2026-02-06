
-- Add relationship_status and interests columns to profiles
ALTER TABLE public.profiles
ADD COLUMN relationship_status text NULL,
ADD COLUMN interests text[] NULL DEFAULT '{}'::text[];

-- Update default field_visibility to include new fields
ALTER TABLE public.profiles
ALTER COLUMN field_visibility SET DEFAULT '{"city": "public", "work": "public", "education": "public", "date_of_birth": "public", "relationship_status": "public", "interests": "public"}'::jsonb;
