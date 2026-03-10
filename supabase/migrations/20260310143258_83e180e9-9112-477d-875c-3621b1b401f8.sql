-- Rate limit match_contacts_by_phone: max 500 phone numbers per call
CREATE OR REPLACE FUNCTION public.match_contacts_by_phone(p_user_id uuid, p_phone_numbers text[])
RETURNS TABLE(user_id uuid, name text, avatar_url text, phone_number text, is_friend boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Rate limit: max 500 numbers per batch
  IF array_length(p_phone_numbers, 1) > 500 THEN
    RAISE EXCEPTION 'Too many phone numbers (max 500)';
  END IF;

  RETURN QUERY
  SELECT 
    p.user_id,
    p.name,
    p.avatar_url,
    p.phone_number,
    EXISTS (
      SELECT 1 FROM friendships f
      WHERE f.status = 'accepted'
        AND (
          (f.requester_id = p_user_id AND f.addressee_id = p.user_id)
          OR (f.requester_id = p.user_id AND f.addressee_id = p_user_id)
        )
    ) as is_friend
  FROM profiles p
  WHERE p.phone_number = ANY(p_phone_numbers)
    AND p.user_id != p_user_id;
END;
$function$;

-- Create a secure view that excludes phone_number for public queries
CREATE OR REPLACE VIEW public.public_profiles AS
SELECT 
  user_id, name, avatar_url, bio, city, profile_type, 
  profile_bg_url, profile_music_url, mood_emoji, mood_text, mood_updated_at,
  cover_url, created_at, date_of_birth, age_verified
FROM profiles;

-- Grant access to the view
GRANT SELECT ON public.public_profiles TO anon, authenticated;
