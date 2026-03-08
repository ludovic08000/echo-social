
-- Add phone_number to profiles (normalized, unique, optional)
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone_number text;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_phone_number_unique ON public.profiles (phone_number) WHERE phone_number IS NOT NULL;

-- Function to match phone numbers against existing profiles
CREATE OR REPLACE FUNCTION public.match_contacts_by_phone(
  p_user_id uuid,
  p_phone_numbers text[]
)
RETURNS TABLE(
  user_id uuid,
  name text,
  avatar_url text,
  phone_number text,
  is_friend boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
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
$$;
