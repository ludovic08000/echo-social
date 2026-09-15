-- Historique restauré depuis Lovable Cloud : schema_migrations, version 20260201062351.
-- Add cover position field to profiles table
ALTER TABLE public.profiles 
ADD COLUMN cover_position_y integer DEFAULT 50;

-- Add comment for clarity
COMMENT ON COLUMN public.profiles.cover_position_y IS 'Vertical position of cover image as percentage (0-100, 50 = centered)';
