-- Historique restauré depuis Lovable Cloud : schema_migrations, version 20260308121637.

CREATE TABLE public.tips (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tipper_id UUID NOT NULL,
  creator_id UUID NOT NULL,
  amount NUMERIC NOT NULL,
  commission_amount NUMERIC NOT NULL,
  creator_payout NUMERIC NOT NULL,
  commission_rate NUMERIC NOT NULL DEFAULT 0.15,
  stripe_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.tips ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view tips they sent" ON public.tips FOR SELECT USING (auth.uid() = tipper_id);
CREATE POLICY "Creators can view tips they received" ON public.tips FOR SELECT USING (auth.uid() = creator_id);
CREATE POLICY "System can insert tips" ON public.tips FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "System can update tips" ON public.tips FOR UPDATE USING (auth.uid() = tipper_id);

