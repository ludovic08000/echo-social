
-- Add creator fields to profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_creator boolean NOT NULL DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS creator_since timestamp with time zone;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS creator_tier text DEFAULT 'free';

-- Creator subscriptions table for future Stripe integration
CREATE TABLE public.creator_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active',
  plan text NOT NULL DEFAULT 'creator_monthly',
  price_cents integer NOT NULL DEFAULT 500,
  currency text NOT NULL DEFAULT 'eur',
  stripe_subscription_id text,
  stripe_customer_id text,
  current_period_start timestamp with time zone,
  current_period_end timestamp with time zone,
  cancelled_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

ALTER TABLE public.creator_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own subscription"
  ON public.creator_subscriptions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own subscription"
  ON public.creator_subscriptions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own subscription"
  ON public.creator_subscriptions FOR UPDATE
  USING (auth.uid() = user_id);
