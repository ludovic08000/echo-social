BEGIN;

-- The browser receives only an item identifier. The server resolves the
-- publisher URL after rechecking publication state and contractual expiry.
CREATE OR REPLACE FUNCTION public.partner_media_thumbnail_source(p_item uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=''
SET statement_timeout='500ms'
AS $$
  SELECT m.thumbnail_url
  FROM public.partner_media_items m
  JOIN public.media_partners p ON p.id=m.partner_id
  WHERE m.id=p_item
    AND m.thumbnail_url IS NOT NULL
    AND m.moderated
    AND m.published_at<=now()
    AND m.expires_at>now()
    AND p.active
    AND p.rights_until>now()
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.partner_media_thumbnail_source(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.partner_media_thumbnail_source(uuid) TO service_role;

COMMIT;
