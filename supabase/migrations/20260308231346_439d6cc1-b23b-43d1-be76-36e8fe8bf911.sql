
CREATE TABLE public.feed_algorithm_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text UNIQUE NOT NULL,
  value jsonb NOT NULL DEFAULT '{}',
  description text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id)
);

ALTER TABLE public.feed_algorithm_config ENABLE ROW LEVEL SECURITY;

-- Only admins can read/write
CREATE POLICY "Admins can manage algorithm config"
  ON public.feed_algorithm_config
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Public read for the app to load config
CREATE POLICY "Anyone can read algorithm config"
  ON public.feed_algorithm_config
  FOR SELECT
  TO authenticated
  USING (true);

-- Insert default config
INSERT INTO public.feed_algorithm_config (key, value, description) VALUES
  ('scoring_weights', '{"recency_max": 50, "engagement_cap": 30, "friend_boost": 8, "discovery_boost": 15, "image_boost": 14, "text_quality_boost": 8, "own_post_boost": 5, "spam_penalty_factor": 0.6, "diversity_penalty_base": 8, "randomization_fresh": 10, "randomization_old": 5}', 'Poids de scoring du feed principal'),
  ('recency_tiers', '{"1h": 50, "3h": 40, "6h": 30, "12h": 18, "24h": 10, "48h": 5, "decay_rate": 72}', 'Paliers de récence en heures'),
  ('time_of_day', '{"morning_boost": 1.3, "midday_boost": 1.3, "evening_boost": 1.3, "work_boost": 1.1, "afternoon_boost": 1.0, "night_factor": 0.7}', 'Multiplicateurs par tranche horaire'),
  ('velocity', '{"comment_weight": 2, "velocity_cap": 20, "log_factor": 5}', 'Paramètres de vélocité d''engagement (trending)'),
  ('marketplace_injection', '{"positions": [2, 12, 23], "products_per_section": 6}', 'Injection marketplace dans le feed'),
  ('anti_spam', '{"char_repeat_penalty": 30, "link_penalty": 20, "spam_word_penalty": 15, "word_repeat_penalty": 25, "caps_penalty": 20, "emoji_penalty": 15}', 'Pénalités anti-spam');
