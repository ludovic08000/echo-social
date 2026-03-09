
-- Table to store restricted friends
CREATE TABLE public.restricted_friends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  restricted_user_id UUID NOT NULL,
  restrict_feed BOOLEAN NOT NULL DEFAULT true,
  restrict_stories BOOLEAN NOT NULL DEFAULT true,
  restrict_messages BOOLEAN NOT NULL DEFAULT true,
  restrict_profile BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(user_id, restricted_user_id)
);

-- RLS
ALTER TABLE public.restricted_friends ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own restrictions"
  ON public.restricted_friends FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own restrictions"
  ON public.restricted_friends FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own restrictions"
  ON public.restricted_friends FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own restrictions"
  ON public.restricted_friends FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Helper function to check if a user is restricted
CREATE OR REPLACE FUNCTION public.is_restricted_by(p_owner_id UUID, p_viewer_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.restricted_friends
    WHERE user_id = p_owner_id AND restricted_user_id = p_viewer_id
  );
$$;
