BEGIN;

-- An inactive parental-control row is retained for audit/history, but must not
-- keep an adult account in the advertising eligibility gate. Known minors and
-- accounts with an active minor protection remain excluded.
CREATE OR REPLACE FUNCTION public.ad_adult_internal(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT EXISTS(
    SELECT 1
    FROM public.profiles AS profile
    WHERE profile.user_id = p_user
      AND profile.date_of_birth <= current_date - interval '18 years'
  )
  AND NOT EXISTS(
    SELECT 1
    FROM public.parental_controls AS controls
    WHERE controls.user_id = p_user
      AND controls.is_minor = true
      AND controls.is_active = true
  );
$$;

REVOKE ALL ON FUNCTION public.ad_adult_internal(uuid) FROM PUBLIC, anon, authenticated;

COMMIT;
