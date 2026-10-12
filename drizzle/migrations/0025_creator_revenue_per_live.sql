ALTER TABLE public.tips ADD COLUMN IF NOT EXISTS live_stream_id uuid NULL;
ALTER TABLE public.tips ADD COLUMN IF NOT EXISTS paid_at timestamptz NULL;
CREATE INDEX IF NOT EXISTS tips_creator_paid_idx ON public.tips (creator_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS tips_live_idx ON public.tips (live_stream_id) WHERE live_stream_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.admin_creator_revenue(p_since timestamptz DEFAULT now() - interval '90 days')
RETURNS TABLE (
  tip_id uuid, creator_id uuid, creator_name text, live_stream_id uuid, live_title text,
  amount numeric, commission_amount numeric, creator_payout numeric, paid_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT t.id, t.creator_id, p.name, t.live_stream_id, ls.title,
         t.amount, t.commission_amount, t.creator_payout,
         COALESCE(t.paid_at, t.created_at)
  FROM public.tips t
  LEFT JOIN public.profiles p ON p.user_id = t.creator_id
  LEFT JOIN public.live_streams ls ON ls.id = t.live_stream_id
  WHERE t.status = 'completed' AND COALESCE(t.paid_at, t.created_at) >= p_since
  ORDER BY COALESCE(t.paid_at, t.created_at) DESC
  LIMIT 2000;
END $$;
REVOKE ALL ON FUNCTION public.admin_creator_revenue(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_creator_revenue(timestamptz) TO authenticated;