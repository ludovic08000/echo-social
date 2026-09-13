-- Historique restauré depuis Lovable Cloud : schema_migrations, version 20260201054338.
-- Add new columns to profiles table
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS cover_url text,
ADD COLUMN IF NOT EXISTS date_of_birth date,
ADD COLUMN IF NOT EXISTS city text,
ADD COLUMN IF NOT EXISTS website_url text,
ADD COLUMN IF NOT EXISTS profile_type text DEFAULT 'user' CHECK (profile_type IN ('user', 'creator'));

-- Create index for friend suggestions (profiles without existing friendship)
CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON public.profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_friendships_status ON public.friendships(status);

-- Function to get friend suggestions based on mutual friends and similar interests
CREATE OR REPLACE FUNCTION public.get_friend_suggestions(target_user_id uuid, limit_count int DEFAULT 10)
RETURNS TABLE (
  user_id uuid,
  name text,
  avatar_url text,
  bio text,
  city text,
  profile_type text,
  mutual_friends_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH my_friends AS (
    SELECT 
      CASE 
        WHEN requester_id = target_user_id THEN addressee_id 
        ELSE requester_id 
      END as friend_id
    FROM friendships
    WHERE (requester_id = target_user_id OR addressee_id = target_user_id)
      AND status = 'accepted'
  ),
  pending_requests AS (
    SELECT 
      CASE 
        WHEN requester_id = target_user_id THEN addressee_id 
        ELSE requester_id 
      END as pending_id
    FROM friendships
    WHERE (requester_id = target_user_id OR addressee_id = target_user_id)
  ),
  mutual_friend_counts AS (
    SELECT 
      p.user_id,
      COUNT(DISTINCT mf.friend_id) as mutual_count
    FROM profiles p
    LEFT JOIN friendships f ON 
      (f.requester_id = p.user_id OR f.addressee_id = p.user_id)
      AND f.status = 'accepted'
    LEFT JOIN my_friends mf ON 
      mf.friend_id = CASE 
        WHEN f.requester_id = p.user_id THEN f.addressee_id 
        ELSE f.requester_id 
      END
    WHERE p.user_id != target_user_id
      AND p.user_id NOT IN (SELECT friend_id FROM my_friends)
      AND p.user_id NOT IN (SELECT pending_id FROM pending_requests)
    GROUP BY p.user_id
  )
  SELECT 
    p.user_id,
    p.name,
    p.avatar_url,
    p.bio,
    p.city,
    p.profile_type,
    COALESCE(mfc.mutual_count, 0) as mutual_friends_count
  FROM profiles p
  LEFT JOIN mutual_friend_counts mfc ON mfc.user_id = p.user_id
  WHERE p.user_id != target_user_id
    AND p.user_id NOT IN (SELECT friend_id FROM my_friends)
    AND p.user_id NOT IN (SELECT pending_id FROM pending_requests)
  ORDER BY mfc.mutual_count DESC NULLS LAST, p.created_at DESC
  LIMIT limit_count;
END;
$$;
