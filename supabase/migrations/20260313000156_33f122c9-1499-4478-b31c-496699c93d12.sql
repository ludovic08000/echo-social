
CREATE INDEX IF NOT EXISTS idx_posts_created_desc_7d 
ON public.posts(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_posts_user_created 
ON public.posts(user_id, created_at DESC);
