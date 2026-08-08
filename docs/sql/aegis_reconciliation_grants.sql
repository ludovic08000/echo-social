-- NON APPLIQUÉ AUTOMATIQUEMENT.
-- Le dossier supabase/migrations est géré par l'outil de migration Lovable et
-- ne peut pas recevoir de fichier écrit à la main. Ce script documente les
-- correctifs déjà appliqués manuellement en base après la PR #68 afin qu'ils
-- puissent être rejoués à l'identique si nécessaire (idempotent).
--
-- Invariant corrigé: les RPC d'enrôlement/diagnostic doivent être exécutables
-- par `authenticated` uniquement, et `verify_own_key_consistency` doit
-- accumuler ses codes avec array_append() (le `text[] || text` produisait
-- `malformed array literal: "device_not_registered"`).

DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'register_user_device_safe',
        'verify_own_key_consistency',
        'aegis_call_latest_for_device'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn.sig);
  END LOOP;
END
$$;
