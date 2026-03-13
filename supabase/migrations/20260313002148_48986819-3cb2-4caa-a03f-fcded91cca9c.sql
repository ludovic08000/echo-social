
-- Fix views with correct column names (no is_verified column)
DROP VIEW IF EXISTS public.profiles_safe;
CREATE VIEW public.profiles_safe AS
  SELECT user_id, name, avatar_url, bio, city, profile_type, mood_emoji, is_creator, created_at
  FROM public.profiles;

DROP VIEW IF EXISTS public.public_profiles;
CREATE VIEW public.public_profiles AS
  SELECT user_id, name, avatar_url, bio, city, profile_type, mood_emoji, is_creator, created_at
  FROM public.profiles;
