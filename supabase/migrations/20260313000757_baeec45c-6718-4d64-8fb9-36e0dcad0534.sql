
-- Re-add denormalized counters (previous migration may have partially failed)
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS likes_count integer NOT NULL DEFAULT 0;
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS comments_count integer NOT NULL DEFAULT 0;

-- Backfill
UPDATE public.posts p SET 
  likes_count = (SELECT COUNT(*) FROM public.likes l WHERE l.post_id = p.id),
  comments_count = (SELECT COUNT(*) FROM public.comments c WHERE c.post_id = p.id);

-- Re-create trigger functions
CREATE OR REPLACE FUNCTION public.update_post_likes_count()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = 'public' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE posts SET likes_count = likes_count + 1 WHERE id = NEW.post_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE posts SET likes_count = GREATEST(0, likes_count - 1) WHERE id = OLD.post_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_post_comments_count()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = 'public' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE posts SET comments_count = comments_count + 1 WHERE id = NEW.post_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE posts SET comments_count = GREATEST(0, comments_count - 1) WHERE id = OLD.post_id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_likes_count ON public.likes;
CREATE TRIGGER trg_likes_count
AFTER INSERT OR DELETE ON public.likes
FOR EACH ROW EXECUTE FUNCTION public.update_post_likes_count();

DROP TRIGGER IF EXISTS trg_comments_count ON public.comments;
CREATE TRIGGER trg_comments_count
AFTER INSERT OR DELETE ON public.comments
FOR EACH ROW EXECUTE FUNCTION public.update_post_comments_count();
