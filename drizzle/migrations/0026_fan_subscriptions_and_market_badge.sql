-- Club d'abonnés : le créateur fixe un prix mensuel, le fan paie pour du contenu réservé.
-- Commission ForSure sur les abonnements des fans : 25 % (règle du propriétaire du 09/10/2026).

CREATE TABLE public.fan_clubs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL UNIQUE REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  is_enabled boolean NOT NULL DEFAULT false,
  monthly_price_cents integer NOT NULL DEFAULT 299,
  description text,
  stripe_product_id text,
  stripe_price_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (monthly_price_cents BETWEEN 199 AND 4999)
);

CREATE TABLE public.fan_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL,
  fan_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  amount_cents integer NOT NULL,
  commission_cents integer NOT NULL,
  creator_payout_cents integer NOT NULL,
  commission_rate numeric NOT NULL DEFAULT 0.25,
  stripe_price_id text,
  stripe_customer_id text,
  stripe_subscription_id text UNIQUE,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (creator_id, fan_id),
  CHECK (status IN ('pending','active','past_due','cancelled','expired')),
  CHECK (amount_cents > 0 AND commission_cents >= 0 AND creator_payout_cents >= 0)
);

CREATE INDEX fan_subscriptions_creator_status_idx ON public.fan_subscriptions (creator_id, status);
CREATE INDEX fan_subscriptions_fan_status_idx ON public.fan_subscriptions (fan_id, status);
CREATE INDEX fan_clubs_stripe_price_idx ON public.fan_clubs (stripe_price_id);

CREATE TRIGGER fan_clubs_touch_updated_at BEFORE UPDATE ON public.fan_clubs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER fan_subscriptions_touch_updated_at BEFORE UPDATE ON public.fan_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Le prix et les identifiants Stripe ne sont modifiables que par la fonction serveur (service_role).
GRANT SELECT ON public.fan_clubs TO anon, authenticated;
GRANT UPDATE (is_enabled, description) ON public.fan_clubs TO authenticated;
GRANT ALL ON public.fan_clubs TO service_role;

GRANT SELECT ON public.fan_subscriptions TO authenticated;
GRANT ALL ON public.fan_subscriptions TO service_role;

ALTER TABLE public.fan_clubs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fan_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enabled fan clubs are viewable" ON public.fan_clubs
  FOR SELECT TO anon, authenticated
  USING (is_enabled OR creator_id = auth.uid());

CREATE POLICY "Owners can edit their fan club" ON public.fan_clubs
  FOR UPDATE TO authenticated
  USING (creator_id = auth.uid())
  WITH CHECK (creator_id = auth.uid());

CREATE POLICY "Fans and creators can view fan subscriptions" ON public.fan_subscriptions
  FOR SELECT TO authenticated
  USING (fan_id = auth.uid() OR creator_id = auth.uid());

-- Badge Créateur actif : seul moyen de gagner de l'argent sur ForSure.
CREATE OR REPLACE FUNCTION public.has_active_creator_badge(p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.creator_subscriptions cs
    WHERE cs.user_id = p_user_id AND cs.status = 'active'
  );
$$;

-- Abonnement fan actif : donne accès au contenu réservé du créateur.
CREATE OR REPLACE FUNCTION public.is_active_fan(p_creator_id uuid, p_fan_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.fan_subscriptions fs
    WHERE fs.creator_id = p_creator_id AND fs.fan_id = p_fan_id AND fs.status = 'active'
  );
$$;

GRANT EXECUTE ON FUNCTION public.has_active_creator_badge(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_active_fan(uuid, uuid) TO anon, authenticated;

-- Publication réservée aux abonnés.
ALTER TABLE public.posts ADD COLUMN subscriber_only boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.posts.subscriber_only IS 'true = publication visible uniquement par le créateur et ses abonnés actifs';

DROP POLICY "Posts respect owner privacy" ON public.posts;
CREATE POLICY "Posts respect owner privacy" ON public.posts
  FOR SELECT
  USING (
    (auth.uid() = user_id)
    OR (
      privacy_scope_allows(user_id, 'profile'::text)
      AND privacy_scope_allows(user_id, 'posts'::text)
      AND current_viewer_parental_post_allowed(id, body)
      AND (subscriber_only = false OR is_active_fan(user_id, auth.uid()))
    )
  );

-- Market : le badge Créateur est obligatoire pour ouvrir une boutique et publier une annonce.
DROP POLICY "Sellers can create products" ON public.products;
CREATE POLICY "Sellers can create products" ON public.products
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.seller_profiles sp
      WHERE sp.id = products.seller_id AND sp.user_id = auth.uid()
    )
    AND has_active_creator_badge(auth.uid())
  );

DROP POLICY "Users can create their own seller profile" ON public.seller_profiles;
CREATE POLICY "Users can create their own seller profile" ON public.seller_profiles
  FOR INSERT
  WITH CHECK (
    auth.uid() = user_id AND has_active_creator_badge(auth.uid())
  );

-- Filet de sécurité : réactiver une annonce sans badge est refusé, même si la politique RLS saute.
CREATE OR REPLACE FUNCTION public.require_badge_to_sell()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_seller uuid;
BEGIN
  IF current_user NOT IN ('service_role','postgres','supabase_admin','supabase_auth_admin') THEN
    IF NEW.is_active AND (TG_OP = 'INSERT' OR OLD.is_active IS DISTINCT FROM NEW.is_active) THEN
      SELECT user_id INTO v_seller FROM public.seller_profiles WHERE id = NEW.seller_id;
      IF v_seller IS NULL OR NOT has_active_creator_badge(v_seller) THEN
        RAISE EXCEPTION 'BADGE_REQUIS : le badge Créateur est nécessaire pour vendre sur le Market.';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER products_require_badge BEFORE INSERT OR UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.require_badge_to_sell();