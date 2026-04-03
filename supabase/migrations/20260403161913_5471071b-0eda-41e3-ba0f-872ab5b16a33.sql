
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS onboarding_step smallint NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.get_onboarding_state(_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'onboarding_completed', p.onboarding_completed,
    'onboarding_step', p.onboarding_step,
    'has_interests', (p.interests IS NOT NULL AND array_length(p.interests, 1) >= 3),
    'has_name', (p.name IS NOT NULL AND p.name <> '')
  )
  FROM public.profiles p
  WHERE p.user_id = _user_id;
$$;

CREATE OR REPLACE FUNCTION public.advance_onboarding_step(
  _user_id uuid,
  _expected_step smallint
)
RETURNS smallint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_step smallint;
BEGIN
  SELECT onboarding_step INTO current_step
  FROM public.profiles
  WHERE user_id = _user_id;

  IF current_step IS NULL THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  IF current_step <> _expected_step THEN
    RAISE EXCEPTION 'Step mismatch: expected %, got %', current_step, _expected_step;
  END IF;

  UPDATE public.profiles
  SET onboarding_step = current_step + 1
  WHERE user_id = _user_id;

  RETURN current_step + 1;
END;
$$;
