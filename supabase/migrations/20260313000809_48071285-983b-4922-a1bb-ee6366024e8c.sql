
-- Materialized view for enriched feed posts
CREATE MATERIALIZED VIEW IF NOT EXISTS public.feed_posts_enriched AS
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
  pr.avatar_url AS author_avatar_url,
  pr.mood_emoji AS author_mood_emoji,
  pr.profile_type AS author_profile_type
FROM public.posts p
JOIN public.profiles pr ON pr.user_id = p.user_id
WHERE p.created_at > now() - interval '7 days';

CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_enriched_id ON public.feed_posts_enriched(id);
CREATE INDEX IF NOT EXISTS idx_feed_enriched_created ON public.feed_posts_enriched(created_at DESC);
