-- Parental controls are globally disabled. Existing rows are retained for
-- audit/rollback, but no row may enforce minor-only routing or feed filters.

UPDATE public.parental_controls
SET
  is_active = false,
  is_minor = false,
  updated_at = pg_catalog.now()
WHERE is_active IS DISTINCT FROM false
   OR is_minor IS DISTINCT FROM false;

CREATE OR REPLACE FUNCTION public.force_parental_controls_disabled()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  NEW.is_active := false;
  NEW.is_minor := false;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.force_parental_controls_disabled()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.force_parental_controls_disabled()
  TO service_role;

DROP TRIGGER IF EXISTS trg_force_parental_controls_disabled
  ON public.parental_controls;
CREATE TRIGGER trg_force_parental_controls_disabled
BEFORE INSERT OR UPDATE ON public.parental_controls
FOR EACH ROW
EXECUTE FUNCTION public.force_parental_controls_disabled();

CREATE OR REPLACE FUNCTION public.is_user_minor(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT false;
$function$;

REVOKE ALL ON FUNCTION public.is_user_minor(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_user_minor(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.is_user_protected_minor(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT false;
$function$;

REVOKE ALL ON FUNCTION public.is_user_protected_minor(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_user_protected_minor(uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.parental_content_category_allowed(
  p_body text,
  p_topics text[],
  p_hashtags text[],
  p_allowed_categories text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT true;
$function$;

REVOKE ALL ON FUNCTION public.parental_content_category_allowed(text, text[], text[], text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.parental_content_category_allowed(text, text[], text[], text[])
  TO service_role;

CREATE OR REPLACE FUNCTION public.current_viewer_parental_post_allowed(
  p_post_id uuid,
  p_body text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT true;
$function$;

REVOKE ALL ON FUNCTION public.current_viewer_parental_post_allowed(uuid, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_viewer_parental_post_allowed(uuid, text)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.force_parental_controls_disabled() IS
  'Global reversible kill switch: prevents parental controls from being reactivated.';
COMMENT ON FUNCTION public.is_user_minor(uuid) IS
  'Parental controls are globally disabled; always returns false.';
COMMENT ON FUNCTION public.is_user_protected_minor(uuid) IS
  'Parental controls are globally disabled; always returns false.';
