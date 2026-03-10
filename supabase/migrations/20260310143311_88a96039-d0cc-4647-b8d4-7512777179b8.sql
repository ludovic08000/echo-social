-- Fix: Remove SECURITY DEFINER from view by recreating with SECURITY INVOKER
DROP VIEW IF EXISTS public.public_profiles;
CREATE VIEW public.public_profiles 
WITH (security_invoker = true)
AS
SELECT 
  user_id, name, avatar_url, bio, city, profile_type, 
  profile_bg_url, profile_music_url, mood_emoji, mood_text, mood_updated_at,
  cover_url, created_at, date_of_birth, age_verified
FROM profiles;

GRANT SELECT ON public.public_profiles TO anon, authenticated;
