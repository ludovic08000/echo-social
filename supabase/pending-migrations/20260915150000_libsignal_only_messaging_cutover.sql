-- NON APPLIQUÉE : cutover destructif « messagerie libsignal exclusivement ».
-- Placée hors de supabase/migrations/ car l'outil de migration de la plateforme
-- applique immédiatement tout fichier de migration, ce qui est interdit ici.
--
-- Invariant cryptographique corrigé : la seule source de sessions, de préclés
-- et de chiffrement est libsignal. Les anciens chemins maison (X3DH/Double
-- Ratchet `aegis1.*`) et WebAuthn/Windows Hello sont supprimés, sans aucun
-- format de compatibilité : un ancien ciphertext reste non déchiffrable.
--
-- Perte de données assumée par le propriétaire : anciens messages, anciennes
-- copies d'appareil, anciennes sessions et anciens enrôlements d'appareil.
-- Les comptes, profils et données sociales ne sont pas touchés.

begin;

-- 1. Purge des capsules et messages produits par l'ancien protocole.
delete from public.message_device_copies
where encrypted_body is null
   or encrypted_body not like 'aegis.libsignal.%';

delete from public.message_device_retry_requests;
delete from public.device_copy_retry_requests;
delete from public.sealed_sender_messages;
delete from public.sealed_sender_events;
delete from public.aegis_device_inbox;
delete from public.e2ee_session_sync;
delete from public.sender_key_distribution;
delete from public.x3dh_replay_ledger;
delete from public.aegis_x3dh_initial_replay;

delete from public.messages
where id not in (select message_id from public.message_device_copies);

-- 2. Suppression des objets WebAuthn/Windows Hello : plus aucun chemin passkey.
drop table if exists public.webauthn_device_challenges cascade;
drop table if exists public.webauthn_device_credentials cascade;
drop table if exists public.webauthn_device_vaults cascade;

-- 3. Suppression des préclés maison. libsignal publie son propre bundle.
drop table if exists public.device_signed_prekeys cascade;
drop table if exists public.device_one_time_prekeys cascade;
drop table if exists public.user_signed_prekeys cascade;

do $$
declare
  obsolete record;
begin
  for obsolete in
    select procedure.oid::regprocedure as signature
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = any (array[
        'claim_device_one_time_prekey',
        'count_device_one_time_prekeys',
        'cleanup_expired_device_prekeys',
        'consume_device_prekey_repair_requests',
        'claim_x3dh_initial',
        'cancel_x3dh_initial',
        'finalize_x3dh_initial',
        'quarantine_own_invalid_device_spk',
        'aegis_verify_signed_prekey'
      ])
  loop
    execute format('drop function if exists %s cascade', obsolete.signature);
  end loop;
end;
$$;

-- 4. Nouvelle porte de routage : un bundle libsignal publié, rien d'autre.
create or replace function public.mark_current_device_route_ready(
  p_device_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_device_id text := trim(coalesce(p_device_id, ''));
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;

  -- Invariant : la route n'est prête qu'avec un bundle libsignal disponible.
  if not exists (
    select 1
    from public.device_libsignal_prekey_bundles bundle
    where bundle.user_id = v_uid
      and bundle.device_id = v_device_id
  ) then
    update public.user_devices
    set routing_status = 'repairing',
        routing_error = 'LIBSIGNAL_BUNDLE_REQUIRED',
        routing_checked_at = now()
    where user_id = v_uid
      and device_id = v_device_id
      and revoked_at is null;
    return jsonb_build_object('ok', false, 'code', 'LIBSIGNAL_BUNDLE_REQUIRED');
  end if;

  update public.user_devices
  set routing_status = 'ready',
      routing_error = null,
      routing_checked_at = now()
  where user_id = v_uid
    and device_id = v_device_id
    and is_active = true
    and revoked_at is null
    and coalesce(approval_status, 'approved') = 'approved';

  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_AUTHORIZED');
  end if;

  return jsonb_build_object('ok', true, 'code', 'DEVICE_ROUTE_READY');
end;
$$;

-- 5. Invalidation des appareils qui n'ont pas encore publié de bundle
-- libsignal : ils repassent par un provisioning canonique complet.
update public.user_devices device
set routing_status = 'repairing',
    routing_error = 'LIBSIGNAL_BUNDLE_REQUIRED',
    lifecycle_status = 'approved',
    routing_checked_at = now()
where device.revoked_at is null
  and not exists (
    select 1
    from public.device_libsignal_prekey_bundles bundle
    where bundle.user_id = device.user_id
      and bundle.device_id = device.device_id
  );

commit;
