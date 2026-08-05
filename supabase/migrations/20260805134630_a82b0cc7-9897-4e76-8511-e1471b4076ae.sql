CREATE TABLE IF NOT EXISTS public.aegis_pin_continuity_vault (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  version integer NOT NULL,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aegis_pin_continuity_version_supported CHECK (version = 1),
  CONSTRAINT aegis_pin_continuity_ciphertext_bounded CHECK (length(ciphertext) BETWEEN 24 AND 8192),
  CONSTRAINT aegis_pin_continuity_iv_bounded CHECK (length(iv) BETWEEN 12 AND 64)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.aegis_pin_continuity_vault TO authenticated;
GRANT ALL ON public.aegis_pin_continuity_vault TO service_role;

ALTER TABLE public.aegis_pin_continuity_vault ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owner reads own pin continuity vault" ON public.aegis_pin_continuity_vault;
CREATE POLICY "Owner reads own pin continuity vault"
  ON public.aegis_pin_continuity_vault FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Owner writes own pin continuity vault" ON public.aegis_pin_continuity_vault;
CREATE POLICY "Owner writes own pin continuity vault"
  ON public.aegis_pin_continuity_vault FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Owner updates own pin continuity vault" ON public.aegis_pin_continuity_vault;
CREATE POLICY "Owner updates own pin continuity vault"
  ON public.aegis_pin_continuity_vault FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Owner deletes own pin continuity vault" ON public.aegis_pin_continuity_vault;
CREATE POLICY "Owner deletes own pin continuity vault"
  ON public.aegis_pin_continuity_vault FOR DELETE TO authenticated
  USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.aegis_pin_continuity_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  NEW.user_id = OLD.user_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_aegis_pin_continuity_touch ON public.aegis_pin_continuity_vault;
CREATE TRIGGER trg_aegis_pin_continuity_touch
  BEFORE UPDATE ON public.aegis_pin_continuity_vault
  FOR EACH ROW EXECUTE FUNCTION public.aegis_pin_continuity_touch();

-- Invariant : le serveur ne détient qu'une enveloppe scellée par la Master Key
-- du compte ; il ne peut ni vérifier ni deviner le PIN.
CREATE OR REPLACE FUNCTION public.aegis_pin_continuity_has()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.aegis_pin_continuity_vault
    WHERE user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.aegis_pin_continuity_get()
RETURNS TABLE (version integer, ciphertext text, iv text, updated_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT v.version, v.ciphertext, v.iv, v.updated_at
  FROM public.aegis_pin_continuity_vault v
  WHERE v.user_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.aegis_pin_continuity_upsert(
  p_version integer,
  p_ciphertext text,
  p_iv text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AEGIS_PIN_CONTINUITY_UNAUTHENTICATED';
  END IF;
  IF p_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'AEGIS_PIN_CONTINUITY_UNSUPPORTED_VERSION';
  END IF;
  IF p_ciphertext IS NULL OR length(p_ciphertext) < 24 OR length(p_ciphertext) > 8192
     OR p_iv IS NULL OR length(p_iv) < 12 OR length(p_iv) > 64 THEN
    RAISE EXCEPTION 'AEGIS_PIN_CONTINUITY_INVALID_ENVELOPE';
  END IF;

  INSERT INTO public.aegis_pin_continuity_vault (user_id, version, ciphertext, iv)
  VALUES (v_uid, p_version, p_ciphertext, p_iv)
  ON CONFLICT (user_id) DO UPDATE
    SET version = EXCLUDED.version,
        ciphertext = EXCLUDED.ciphertext,
        iv = EXCLUDED.iv;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.aegis_pin_continuity_delete()
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AEGIS_PIN_CONTINUITY_UNAUTHENTICATED';
  END IF;
  DELETE FROM public.aegis_pin_continuity_vault WHERE user_id = v_uid;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.aegis_pin_continuity_has() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.aegis_pin_continuity_get() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.aegis_pin_continuity_upsert(integer, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.aegis_pin_continuity_delete() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.aegis_pin_continuity_has() TO authenticated;
GRANT EXECUTE ON FUNCTION public.aegis_pin_continuity_get() TO authenticated;
GRANT EXECUTE ON FUNCTION public.aegis_pin_continuity_upsert(integer, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.aegis_pin_continuity_delete() TO authenticated;