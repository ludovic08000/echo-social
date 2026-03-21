
-- Notifications: user unread (correct column name)
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;

-- Profiles: user_id lookup
CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON profiles (user_id);

-- Trust scores
CREATE INDEX IF NOT EXISTS idx_trust_scores_user ON trust_scores (user_id);

-- ═══════════════════════════════════════════════════════════════
-- RPC: get_feed_posts — single query for entire feed
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_feed_posts(
  p_user_id UUID,
  p_limit INTEGER DEFAULT 20,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  id UUID,
  user_id UUID,
  body TEXT,
  image_url TEXT,
  created_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  likes_count INTEGER,
  comments_count INTEGER,
  author_name TEXT,
  author_avatar TEXT,
  author_mood TEXT,
  user_reaction TEXT,
  is_friend BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
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
    AND p.created_at > now() - interval '7 days'
  ORDER BY
    CASE WHEN p.user_id = p_user_id THEN 1 ELSE 0 END DESC,
    CASE WHEN f.friend_id IS NOT NULL THEN 1 ELSE 0 END DESC,
    p.created_at DESC
  LIMIT p_limit
  OFFSET p_offset;
$$;

-- ═══════════════════════════════════════════════════════════════
-- RPC: get_conversations_with_details — single query for inbox
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_conversations_with_details(p_user_id UUID)
RETURNS TABLE (
  conv_id UUID,
  conv_created_at TIMESTAMPTZ,
  conv_updated_at TIMESTAMPTZ,
  is_group BOOLEAN,
  conv_name TEXT,
  created_by UUID,
  other_user_id UUID,
  other_name TEXT,
  other_avatar TEXT,
  last_message_body TEXT,
  last_message_at TIMESTAMPTZ,
  last_message_sender UUID,
  unread_count BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
  WITH my_convs AS (
    SELECT cp.conversation_id, cp.last_read_at
    FROM conversation_participants cp
    WHERE cp.user_id = p_user_id
  ),
  last_msgs AS (
    SELECT DISTINCT ON (m.conversation_id)
      m.conversation_id,
      m.body,
      m.created_at,
      m.sender_id
    FROM messages m
    JOIN my_convs mc ON mc.conversation_id = m.conversation_id
    ORDER BY m.conversation_id, m.created_at DESC
  ),
  unreads AS (
    SELECT m.conversation_id, COUNT(*) AS cnt
    FROM messages m
    JOIN my_convs mc ON mc.conversation_id = m.conversation_id
    WHERE m.sender_id != p_user_id
      AND (mc.last_read_at IS NULL OR m.created_at > mc.last_read_at)
      AND m.status = 'delivered'
    GROUP BY m.conversation_id
  ),
  other_parts AS (
    SELECT DISTINCT ON (cp.conversation_id)
      cp.conversation_id,
      cp.user_id,
      pr.name,
      pr.avatar_url
    FROM conversation_participants cp
    JOIN my_convs mc ON mc.conversation_id = cp.conversation_id
    LEFT JOIN profiles pr ON pr.user_id = cp.user_id
    WHERE cp.user_id != p_user_id
    ORDER BY cp.conversation_id, cp.joined_at
  )
  SELECT
    c.id AS conv_id,
    c.created_at AS conv_created_at,
    c.updated_at AS conv_updated_at,
    c.is_group,
    c.name AS conv_name,
    c.created_by,
    op.user_id AS other_user_id,
    COALESCE(
      CASE WHEN op.user_id = '00000000-0000-0000-0000-000000000001' THEN 'Zeus ⚡' ELSE op.name END,
      'Unknown'
    ) AS other_name,
    op.avatar_url AS other_avatar,
    lm.body AS last_message_body,
    lm.created_at AS last_message_at,
    lm.sender_id AS last_message_sender,
    COALESCE(u.cnt, 0) AS unread_count
  FROM conversations c
  JOIN my_convs mc ON mc.conversation_id = c.id
  LEFT JOIN other_parts op ON op.conversation_id = c.id
  LEFT JOIN last_msgs lm ON lm.conversation_id = c.id
  LEFT JOIN unreads u ON u.conversation_id = c.id
  ORDER BY COALESCE(lm.created_at, c.updated_at) DESC;
$$;
