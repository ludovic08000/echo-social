
-- Add inserted_at column to user_feed for cleanup tracking
ALTER TABLE public.user_feed ADD COLUMN IF NOT EXISTS inserted_at timestamptz NOT NULL DEFAULT now();

-- Index for cleanup queries
CREATE INDEX IF NOT EXISTS idx_user_feed_inserted_at ON public.user_feed (inserted_at);

-- Index for notification cleanup
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON public.notifications (created_at);

-- Index for expired posts cleanup
CREATE INDEX IF NOT EXISTS idx_posts_expires_at ON public.posts (expires_at) WHERE expires_at IS NOT NULL;
