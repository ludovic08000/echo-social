
-- Add parent_id to comments for threaded replies
ALTER TABLE public.comments ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES public.comments(id) ON DELETE CASCADE;

-- Create comment_likes table
CREATE TABLE IF NOT EXISTS public.comment_likes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id uuid REFERENCES public.comments(id) ON DELETE CASCADE NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(comment_id, user_id)
);

ALTER TABLE public.comment_likes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read comment likes" ON public.comment_likes FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can like comments" ON public.comment_likes FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can unlike comments" ON public.comment_likes FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Add unique constraint on likes table to prevent duplicate reactions
ALTER TABLE public.likes DROP CONSTRAINT IF EXISTS likes_user_post_unique;
ALTER TABLE public.likes ADD CONSTRAINT likes_user_post_unique UNIQUE (user_id, post_id);
