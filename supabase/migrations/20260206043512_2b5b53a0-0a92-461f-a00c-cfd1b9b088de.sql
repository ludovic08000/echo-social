
-- Drop and recreate the friend suggestions function with city + mutual friends scoring
CREATE OR REPLACE FUNCTION public.get_friend_suggestions(target_user_id uuid, limit_count integer DEFAULT 10)
RETURNS TABLE(user_id uuid, name text, avatar_url text, bio text, city text, profile_type text, mutual_friends_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  WITH my_profile AS (
    SELECT p.city as my_city
    FROM profiles p
    WHERE p.user_id = target_user_id
  ),
  my_friends AS (
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
  friends_of_friends AS (
    SELECT 
      CASE 
        WHEN f.requester_id = mf.friend_id THEN f.addressee_id 
        ELSE f.requester_id 
      END as fof_id,
      COUNT(*) as mutual_count
    FROM my_friends mf
    JOIN friendships f ON (f.requester_id = mf.friend_id OR f.addressee_id = mf.friend_id)
      AND f.status = 'accepted'
    WHERE CASE 
        WHEN f.requester_id = mf.friend_id THEN f.addressee_id 
        ELSE f.requester_id 
      END != target_user_id
      AND CASE 
        WHEN f.requester_id = mf.friend_id THEN f.addressee_id 
        ELSE f.requester_id 
      END NOT IN (SELECT friend_id FROM my_friends)
      AND CASE 
        WHEN f.requester_id = mf.friend_id THEN f.addressee_id 
        ELSE f.requester_id 
      END NOT IN (SELECT pending_id FROM pending_requests)
    GROUP BY fof_id
  )
  SELECT 
    p.user_id,
    p.name,
    p.avatar_url,
    p.bio,
    p.city,
    p.profile_type,
    COALESCE(fof.mutual_count, 0) as mutual_friends_count
  FROM profiles p
  CROSS JOIN my_profile mp
  LEFT JOIN friends_of_friends fof ON fof.fof_id = p.user_id
  WHERE p.user_id != target_user_id
    AND p.user_id NOT IN (SELECT friend_id FROM my_friends)
    AND p.user_id NOT IN (SELECT pending_id FROM pending_requests)
  ORDER BY 
    -- Score: friends of friends first, then same city, then recent
    (COALESCE(fof.mutual_count, 0) * 3) + 
    (CASE WHEN mp.my_city IS NOT NULL AND p.city IS NOT NULL AND LOWER(TRIM(p.city)) = LOWER(TRIM(mp.my_city)) THEN 2 ELSE 0 END)
    DESC,
    p.created_at DESC
  LIMIT limit_count;
END;
$function$;
