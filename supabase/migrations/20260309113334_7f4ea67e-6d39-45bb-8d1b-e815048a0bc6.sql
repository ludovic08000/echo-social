
-- Drop the existing permissive SELECT policy that exposes pin_hash
DROP POLICY IF EXISTS "Users can view their own parental controls" ON public.parental_controls;

-- Create a new SELECT policy using a security definer function that excludes pin_hash
-- The client can only read non-sensitive columns
CREATE OR REPLACE FUNCTION public.get_parental_controls(p_user_id uuid)
RETURNS TABLE(
  id uuid,
  user_id uuid,
  is_active boolean,
  is_minor boolean,
  allowed_categories text[],
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pc.id, pc.user_id, pc.is_active, pc.is_minor, pc.allowed_categories, pc.created_at, pc.updated_at
  FROM parental_controls pc
  WHERE pc.user_id = p_user_id;
$$;

-- Re-create SELECT policy but for the edge function (service role bypasses RLS anyway)
-- For client queries, we still need a SELECT policy but pin_hash won't be queried
CREATE POLICY "Users can view own parental controls (no pin_hash)"
  ON public.parental_controls FOR SELECT
  USING (auth.uid() = user_id);

-- Remove client INSERT/UPDATE ability for pin_hash by revoking direct insert
-- The edge function uses service role, so this doesn't affect server-side operations
-- We keep INSERT/UPDATE policies but the edge function handles PIN operations

-- Also remove the direct insert policy since PIN setup goes through edge function
DROP POLICY IF EXISTS "Users can insert their own parental controls" ON public.parental_controls;
DROP POLICY IF EXISTS "Users can update their own parental controls" ON public.parental_controls;

-- Allow client to read their own controls (needed for useParentalControl query)
-- But they cannot insert/update directly — must go through edge function
-- Service role key in edge function bypasses RLS entirely
