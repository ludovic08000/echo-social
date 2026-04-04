
CREATE OR REPLACE FUNCTION public.get_feed_posts(p_user_id uuid, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, user_id uuid, body text, image_url text, created_at timestamp with time zone, expires_at timestamp with time zone, likes_count integer, comments_count integer, author_name text, author_avatar text, author_mood text, user_reaction text, is_friend boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $$
  WITH friends AS (
    SELECT CASE 
      WHEN requester_id = p_user_id THEN addressee_id 
      ELSE requester_id 
    END AS friend_id
    FROM friendships
    WHERE (requester_id = p_user_id OR addressee_id = p_user_id)
      AND status = 'accepted'
  )
  SELECT
    p.id,
    p.user_id,
    p.body,
    p.image_url,
    p.created_at,
    p.expires_at,
    p.likes_count,
    p.comments_count,
    pr.name AS author_name,
    pr.avatar_url AS author_avatar,
    pr.mood_emoji AS author_mood,
    l.reaction_type AS user_reaction,
    (f.friend_id IS NOT NULL) AS is_friend
  FROM posts p
  JOIN profiles pr ON pr.user_id = p.user_id
  LEFT JOIN likes l ON l.post_id = p.id AND l.user_id = p_user_id
  LEFT JOIN friends f ON f.friend_id = p.user_id
  WHERE (p.expires_at IS NULL OR p.expires_at > now())
    AND p.created_at > now() - interval '30 days'
  ORDER BY
    CASE WHEN p.user_id = p_user_id THEN 1 ELSE 0 END DESC,
    CASE WHEN f.friend_id IS NOT NULL THEN 1 ELSE 0 END DESC,
    p.created_at DESC
  LIMIT p_limit
  OFFSET p_offset;
$$;
