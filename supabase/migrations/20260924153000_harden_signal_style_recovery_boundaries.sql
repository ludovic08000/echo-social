begin;

-- Les clés de récupération restent opaques pour Lovable Cloud. Le serveur ne
-- valide que leur enveloppe et leur portée afin d'empêcher l'empoisonnement,
-- l'écrasement ou l'archivage dans une conversation étrangère.
create or replace function public.is_supported_conversation_archive_key(
  p_wrapped_key text,
  p_kdf_version smallint
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_kdf_version <> 1
     or p_wrapped_key is null
     or char_length(p_wrapped_key) <> 80
     or p_wrapped_key !~ '^[A-Za-z0-9+/]{80}$' then
    return false;
  end if;

  return octet_length(decode(p_wrapped_key, 'base64')) = 60;
exception
  when others then
    return false;
end;
$$;

create or replace function public.enforce_supported_conversation_archive_key()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.is_supported_conversation_archive_key(
    new.wrapped_key,
    new.kdf_version
  ) then
    raise exception 'AEGIS_ARCHIVE_KEY_INVALID' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_supported_conversation_archive_key
  on public.conversation_archive_keys;
create trigger enforce_supported_conversation_archive_key
  before insert or update of wrapped_key, kdf_version
  on public.conversation_archive_keys
  for each row
  execute function public.enforce_supported_conversation_archive_key();

revoke all on table public.conversation_archive_keys from anon, authenticated;
grant select, insert on table public.conversation_archive_keys to authenticated;

drop policy if exists "archive_keys_owner_insert"
  on public.conversation_archive_keys;
create policy "archive_keys_owner_insert"
  on public.conversation_archive_keys
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and public.is_conversation_participant(
      conversation_id,
      (select auth.uid())
    )
  );

-- Une clé d'archive est write-once. La rotation crée une nouvelle version de
-- protocole ; un client compromis ne peut pas détruire l'historique existant.
drop policy if exists "archive_keys_owner_update"
  on public.conversation_archive_keys;
drop policy if exists "archive_keys_owner_delete"
  on public.conversation_archive_keys;

revoke all on table public.message_archives from anon, authenticated;
grant select, insert on table public.message_archives to authenticated;

drop policy if exists "ma_insert_own" on public.message_archives;
create policy "ma_insert_own"
  on public.message_archives
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.messages as parent_message
      where parent_message.id = message_archives.message_id
        and public.is_conversation_participant(
          parent_message.conversation_id,
          (select auth.uid())
        )
    )
  );

-- Cette lecture n'a besoin d'aucun privilège propriétaire : RLS reste la
-- frontière et évite une fonction SECURITY DEFINER inutile.
create or replace function public.get_user_archive_keys()
returns table (
  conversation_id uuid,
  wrapped_key text,
  kdf_version smallint,
  created_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    archive_key.conversation_id,
    archive_key.wrapped_key,
    archive_key.kdf_version,
    archive_key.created_at
  from public.conversation_archive_keys as archive_key
  where archive_key.user_id = (select auth.uid());
$$;

revoke all on function public.get_user_archive_keys() from public, anon;
grant execute on function public.get_user_archive_keys() to authenticated;

revoke all on function public.set_message_archive_body(uuid, text)
  from public, anon;
grant execute on function public.set_message_archive_body(uuid, text)
  to authenticated;

create or replace function public.enforce_valid_aegis_recovery_vault_envelope()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_salt bytea;
  v_nonce bytea;
  v_ciphertext bytea;
begin
  v_salt := decode(new.kdf_salt, 'base64');
  v_nonce := decode(new.nonce, 'base64');
  v_ciphertext := decode(new.ciphertext, 'base64');

  if new.protocol_version <> 1
     or new.generation < 1
     or char_length(new.identity_fingerprint) not between 16 and 256
     or octet_length(v_salt) <> 32
     or octet_length(v_nonce) <> 12
     or octet_length(v_ciphertext) <= 16
     or octet_length(v_ciphertext) > 786432
     or new.kdf_salt !~ '^[A-Za-z0-9+/]{43}=$'
     or new.nonce !~ '^[A-Za-z0-9+/]{16}$'
     or new.ciphertext !~ '^[A-Za-z0-9+/]+={0,2}$'
     or mod(char_length(new.ciphertext), 4) <> 0 then
    raise exception 'INVALID_RECOVERY_VAULT_PAYLOAD' using errcode = '22023';
  end if;

  return new;
exception
  when others then
    raise exception 'INVALID_RECOVERY_VAULT_PAYLOAD' using errcode = '22023';
end;
$$;

drop trigger if exists enforce_valid_aegis_recovery_vault_envelope
  on public.aegis_recovery_vaults;
create trigger enforce_valid_aegis_recovery_vault_envelope
  before insert or update of
    protocol_version,
    generation,
    identity_fingerprint,
    kdf_salt,
    nonce,
    ciphertext
  on public.aegis_recovery_vaults
  for each row
  execute function public.enforce_valid_aegis_recovery_vault_envelope();

revoke all on function public.enforce_supported_conversation_archive_key()
  from public, anon, authenticated;
revoke all on function public.enforce_valid_aegis_recovery_vault_envelope()
  from public, anon, authenticated;

comment on function public.is_supported_conversation_archive_key(text, smallint) is
  'Validates the opaque AES-256-GCM conversation archive-key envelope.';
comment on function public.enforce_valid_aegis_recovery_vault_envelope() is
  'Rejects malformed or non-canonical zero-access recovery vault envelopes.';

commit;
