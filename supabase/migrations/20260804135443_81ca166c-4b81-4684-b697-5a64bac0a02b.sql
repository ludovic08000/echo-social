-- Invariant corrigé : une autorisation d'appareil signée par une identité de
-- compte archivée n'est plus une autorisation valide. Elle doit être effacée
-- (jamais l'appareil révoqué) pour que l'appareil la re-signe avec l'identité
-- courante, sinon le registre entier devient invalide et bloque les envois.

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

  -- Les autorisations existantes ont été signées par l'ancienne clé de compte.
  -- On les efface uniquement : is_active et revoked_at restent intacts.
  UPDATE public.user_devices
     SET device_authorization_signature = NULL,
         routing_status = 'repairing',
         routing_error = 'ACCOUNT_IDENTITY_REPLACED',
         routing_checked_at = now(),
         updated_at = now()
   WHERE user_id = v_user
     AND revoked_at IS NULL
     AND device_authorization_signature IS NOT NULL;

  RETURN p_fingerprint;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_own_identity_key(text, text, text, int, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_own_identity_key(text, text, text, int, text) TO authenticated;

-- Réparation des données existantes : autorisations antérieures à l'identité
-- active courante (donc signées par une identité archivée).
UPDATE public.user_devices d
   SET device_authorization_signature = NULL,
       routing_status = 'repairing',
       routing_error = 'ACCOUNT_IDENTITY_REPLACED',
       routing_checked_at = now(),
       updated_at = now()
  FROM public.user_public_keys k
 WHERE k.user_id = d.user_id
   AND k.is_active = true
   AND d.revoked_at IS NULL
   AND d.device_authorization_signature IS NOT NULL
   AND COALESCE(d.updated_at, d.created_at) < k.created_at;