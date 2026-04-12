
ALTER TABLE public.comment_likes
ADD COLUMN reaction_type text NOT NULL DEFAULT 'like';
