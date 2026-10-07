BEGIN;

-- Partner news is an automatic feed feature. Advertising consent remains
-- separate and is not read or changed by this function.
CREATE OR REPLACE FUNCTION public.get_contextual_partner_media(
  p_scope text,
  p_kind text,
  p_country text,
  p_region text,
  p_city text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=''
SET statement_timeout='1500ms'
AS $$
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  IF p_country IS DISTINCT FROM 'FR'
     OR length(coalesce(p_region,''))>100
     OR length(coalesce(p_city,''))>100 THEN
    RETURN public.partner_media_for_zone(p_scope,p_kind,NULL,NULL,NULL);
  END IF;

  RETURN public.partner_media_for_zone(p_scope,p_kind,p_country,p_region,p_city);
END;
$$;

REVOKE ALL ON FUNCTION public.get_contextual_partner_media(text,text,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_contextual_partner_media(text,text,text,text,text) TO authenticated;

COMMIT;
