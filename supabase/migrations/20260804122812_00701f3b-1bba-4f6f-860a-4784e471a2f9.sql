-- Invariant corrigé : le remplacement d'identité doit être atomique et ne
-- jamais laisser le compte sans identité active (l'ancien chemin archivait
-- puis insérait en deux requêtes non transactionnelles).

ALTER TABLE public.user_public_keys
  DROP CONSTRAINT IF EXISTS user_public_keys_user_id_is_active_key;
DROP INDEX IF EXISTS public.user_public_keys_user_id_is_active_key;

CREATE UNIQUE INDEX IF NOT EXISTS user_public_keys_one_active_per_user
  ON public.user_public_keys (user_id) WHERE (is_active = true);

CREATE OR REPLACE FUNCTION public.replace_own_identity_key(
  p_identity_key text,
  p_signing_key text,
  p_fingerprint text,
  p_binding_version int,
  p_binding_signature text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;

  IF p_identity_key IS NULL OR p_signing_key IS NULL OR p_fingerprint IS NULL
     OR p_binding_signature IS NULL OR p_binding_version IS NULL THEN
    RAISE EXCEPTION 'INVALID_IDENTITY_BUNDLE';
  END IF;

  -- Une identité encore récupérable ne doit jamais être remplacée.
  IF EXISTS (SELECT 1 FROM public.user_backups WHERE user_id = v_user)
     OR EXISTS (SELECT 1 FROM public.aegis_recovery_vaults WHERE user_id = v_user) THEN
    RAISE EXCEPTION 'RECOVERABLE_BACKUP_EXISTS';
  END IF;

  UPDATE public.user_public_keys
     SET is_active = false, updated_at = now()
   WHERE user_id = v_user AND is_active = true;

  INSERT INTO public.user_public_keys (
    user_id, identity_key, signing_key, fingerprint,
    identity_binding_version, identity_binding_signature,
    kem_type, is_active, updated_at
  ) VALUES (
    v_user, p_identity_key, p_signing_key, p_fingerprint,
    p_binding_version, p_binding_signature,
    'X25519', true, now()
  );

  RETURN p_fingerprint;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_own_identity_key(text, text, text, int, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_own_identity_key(text, text, text, int, text) TO authenticated;