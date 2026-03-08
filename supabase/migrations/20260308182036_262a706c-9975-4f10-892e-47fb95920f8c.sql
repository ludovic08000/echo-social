
-- Negotiations table for buyer-seller price negotiation
CREATE TABLE public.negotiations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID REFERENCES public.products(id) ON DELETE CASCADE NOT NULL,
  buyer_id UUID NOT NULL,
  seller_profile_id UUID REFERENCES public.seller_profiles(id) ON DELETE CASCADE NOT NULL,
  conversation_id UUID REFERENCES public.conversations(id),
  original_price NUMERIC NOT NULL,
  offered_price NUMERIC NOT NULL,
  counter_price NUMERIC,
  status TEXT NOT NULL DEFAULT 'pending',
  order_id UUID REFERENCES public.orders(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.negotiations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Buyers can view own negotiations" ON public.negotiations
  FOR SELECT TO authenticated USING (buyer_id = auth.uid());

CREATE POLICY "Sellers can view their negotiations" ON public.negotiations
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.seller_profiles sp WHERE sp.id = seller_profile_id AND sp.user_id = auth.uid()));

CREATE POLICY "Buyers can create negotiations" ON public.negotiations
  FOR INSERT TO authenticated WITH CHECK (buyer_id = auth.uid());

CREATE POLICY "Participants can update negotiations" ON public.negotiations
  FOR UPDATE TO authenticated
  USING (buyer_id = auth.uid() OR EXISTS (SELECT 1 FROM public.seller_profiles sp WHERE sp.id = seller_profile_id AND sp.user_id = auth.uid()));

ALTER PUBLICATION supabase_realtime ADD TABLE public.negotiations;
