
-- Create profiles_safe view with phone_number hidden from non-owners
CREATE OR REPLACE VIEW public.profiles_safe WITH (security_invoker = on) AS
SELECT id, user_id, name, avatar_url, bio, city, profile_type,
  date_of_birth, mood_emoji, mood_text, mood_updated_at,
  cover_url, cover_position_y, website_url,
  education_level, education_city, work, field_visibility,
  relationship_status, interests, profile_music_url,
  is_creator, creator_since, creator_tier,
  profile_bg_url, feed_bg_url,
  created_at, updated_at,
  CASE WHEN user_id = auth.uid() THEN phone_number ELSE NULL END as phone_number
FROM public.profiles;

-- Fix security invoker on anonymous view
ALTER VIEW public.anonymous_wall_messages_public SET (security_invoker = on);
