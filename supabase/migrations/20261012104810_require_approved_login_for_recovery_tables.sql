begin;

-- Une session mot de passe non approuvée ne doit pas lire ou modifier les
-- sauvegardes chiffrées. Ces règles restrictives s'ajoutent aux règles de
-- propriété existantes : elles ne donnent aucun accès à un autre compte.
-- Le prédicat conserve le commutateur de déploiement login_security_config.
-- Un refus doit être une erreur explicite, pas un résultat vide interprétable
-- comme « premier compte sans sauvegarde » par un client de restauration.
create function public.require_approved_recovery_login()
returns boolean language plpgsql stable security invoker
set search_path = public, pg_temp
as $$
begin
  perform public.assert_current_login_session_approved();
  return true;
end;
$$;
revoke all on function public.require_approved_recovery_login() from public, anon;
grant execute on function public.require_approved_recovery_login() to authenticated, service_role;

create policy recovery_requires_approved_login
  on public.user_backups
  as restrictive for all to authenticated
  using ((select public.require_approved_recovery_login()))
  with check ((select public.require_approved_recovery_login()));

create policy recovery_requires_approved_login
  on public.conversation_archive_keys
  as restrictive for all to authenticated
  using ((select public.require_approved_recovery_login()))
  with check ((select public.require_approved_recovery_login()));

create policy recovery_requires_approved_login
  on public.message_archives
  as restrictive for all to authenticated
  using ((select public.require_approved_recovery_login()))
  with check ((select public.require_approved_recovery_login()));

-- Aucun format, contenu, clé ou droit write-once n'est modifié. Le RPC
-- get_user_archive_keys est SECURITY INVOKER et reste soumis à ces règles.
-- Retour arrière ciblé dans une nouvelle migration : supprimer uniquement
-- recovery_requires_approved_login sur ces trois tables, jamais les données
-- ni les autres règles de propriété/approbation.
commit;
