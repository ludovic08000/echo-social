
CREATE OR REPLACE FUNCTION public.complete_onboarding(_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_step smallint;
  v_name text;
  v_interest_count integer;
BEGIN
  -- Get current state
  SELECT onboarding_step, name INTO v_step, v_name
  FROM public.profiles
  WHERE user_id = _user_id;

  IF v_step IS NULL THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  -- Must be at step 2 or higher (interests + ai-name done)
  IF v_step < 2 THEN
    RAISE EXCEPTION 'Onboarding steps not completed (current: %)', v_step;
  END IF;

  -- Validate name exists
  IF v_name IS NULL OR v_name = '' THEN
    RAISE EXCEPTION 'Name is required';
  END IF;

  -- Validate at least 3 interests saved
  SELECT COUNT(*) INTO v_interest_count
  FROM public.user_interests
  WHERE user_id = _user_id;

  IF v_interest_count < 3 THEN
    RAISE EXCEPTION 'At least 3 interests required (found: %)', v_interest_count;
  END IF;

  -- All checks pass → mark completed
  UPDATE public.profiles
  SET onboarding_completed = true,
      onboarding_step = 3
  WHERE user_id = _user_id;

  RETURN true;
END;
$$;
