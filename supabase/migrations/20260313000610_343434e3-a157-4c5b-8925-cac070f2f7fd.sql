
-- user_feed table for fan-out on write
CREATE TABLE IF NOT EXISTS public.user_feed (
  user_id uuid NOT NULL,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  score float NOT NULL DEFAULT 0,
  inserted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);

CREATE INDEX IF NOT EXISTS idx_user_feed_score ON public.user_feed(user_id, score DESC);

ALTER TABLE public.user_feed ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own feed" ON public.user_feed
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Fan-out function
CREATE OR REPLACE FUNCTION public.fan_out_new_post()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = 'public' AS $$
BEGIN
  INSERT INTO user_feed (user_id, post_id, score)
  VALUES (NEW.user_id, NEW.id, 500)
  ON CONFLICT DO NOTHING;

  INSERT INTO user_feed (user_id, post_id, score)
  SELECT 
    CASE WHEN f.requester_id = NEW.user_id THEN f.addressee_id ELSE f.requester_id END,
    NEW.id,
    100
  FROM friendships f
  WHERE (f.requester_id = NEW.user_id OR f.addressee_id = NEW.user_id)
    AND f.status = 'accepted'
  LIMIT 1000
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fan_out_post ON public.posts;
CREATE TRIGGER trg_fan_out_post
AFTER INSERT ON public.posts
FOR EACH ROW EXECUTE FUNCTION public.fan_out_new_post();

-- Index on messages for cursor pagination
CREATE INDEX IF NOT EXISTS idx_messages_conv_created_desc 
ON public.messages(conversation_id, created_at DESC);
