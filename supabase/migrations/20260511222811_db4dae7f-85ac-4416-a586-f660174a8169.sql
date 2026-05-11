-- 1) Allow Zeus system replies on comments
ALTER TABLE public.comments ADD COLUMN IF NOT EXISTS is_zeus_reply boolean NOT NULL DEFAULT false;
ALTER TABLE public.comments DROP CONSTRAINT IF EXISTS comments_user_id_fkey;
ALTER TABLE public.comments ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.comments ADD CONSTRAINT comments_user_or_zeus
  CHECK (user_id IS NOT NULL OR is_zeus_reply = true);

-- 2) Moderation alerts table
CREATE TABLE IF NOT EXISTS public.comment_moderation_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  comment_id uuid REFERENCES public.comments(id) ON DELETE SET NULL,
  post_id uuid REFERENCES public.posts(id) ON DELETE SET NULL,
  evidence_text text NOT NULL,
  category text NOT NULL,
  severity text NOT NULL DEFAULT 'warning',
  ai_reasoning text,
  strike_count int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending',
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cma_status_created ON public.comment_moderation_alerts(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cma_user ON public.comment_moderation_alerts(user_id);

ALTER TABLE public.comment_moderation_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read alerts" ON public.comment_moderation_alerts;
CREATE POLICY "Admins read alerts" ON public.comment_moderation_alerts
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Admins update alerts" ON public.comment_moderation_alerts;
CREATE POLICY "Admins update alerts" ON public.comment_moderation_alerts
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin'));

DROP TRIGGER IF EXISTS trg_cma_updated ON public.comment_moderation_alerts;
CREATE TRIGGER trg_cma_updated
  BEFORE UPDATE ON public.comment_moderation_alerts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();