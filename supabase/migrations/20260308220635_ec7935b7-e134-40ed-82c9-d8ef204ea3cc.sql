
-- Parental controls table
CREATE TABLE public.parental_controls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  pin_hash text NOT NULL,
  is_minor boolean NOT NULL DEFAULT true,
  allowed_categories text[] NOT NULL DEFAULT ARRAY['education', 'sport', 'gaming', 'musique', 'art', 'humour']::text[],
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.parental_controls ENABLE ROW LEVEL SECURITY;

-- User can read their own parental controls
CREATE POLICY "Users can view their own parental controls"
  ON public.parental_controls FOR SELECT
  USING (auth.uid() = user_id);

-- User can insert their own parental controls
CREATE POLICY "Users can insert their own parental controls"
  ON public.parental_controls FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- User can update their own parental controls
CREATE POLICY "Users can update their own parental controls"
  ON public.parental_controls FOR UPDATE
  USING (auth.uid() = user_id);
