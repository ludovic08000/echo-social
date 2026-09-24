-- Les messages Aegis ordinaires doivent rester récupérables après la perte du
-- stockage local. Le serveur ne voit toujours que le ciphertext de l'archive.

create or replace function public.is_supported_aegis_archive(
  p_archive_body text,
  p_message_id uuid
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_payload jsonb;
begin
  if p_archive_body is null
     or p_message_id is null
     or char_length(p_archive_body) not between 40 and 262144 then
    return false;
  end if;

  v_payload := p_archive_body::jsonb;
  if jsonb_typeof(v_payload) <> 'object'
     or coalesce(v_payload ->> 'v', '') <> '2'
     or coalesce(v_payload ->> 'context', '') <> p_message_id::text
     or coalesce(v_payload ->> 'iv', '') = ''
     or coalesce(v_payload ->> 'ct', '') = '' then
    return false;
  end if;

  return octet_length(decode(v_payload ->> 'iv', 'base64')) = 12
     and octet_length(decode(v_payload ->> 'ct', 'base64')) >= 16;
exception
  when others then
    return false;
end;
$$;

create or replace function public.enforce_recoverable_aegis_message()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Invariant : seul le message à vue unique peut volontairement ne pas avoir
  -- d'archive durable. Une archive fournie doit toujours être liée à l'UUID.
  if new.body_kind = 'multi_device'
     and not coalesce(new.view_once, false)
     and not public.is_supported_aegis_archive(new.archive_body, new.id) then
    raise exception 'AEGIS_ARCHIVE_REQUIRED'
      using errcode = '23514';
  end if;

  if new.archive_body is not null
     and not public.is_supported_aegis_archive(new.archive_body, new.id) then
    raise exception 'AEGIS_ARCHIVE_INVALID'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_recoverable_aegis_message on public.messages;
create trigger enforce_recoverable_aegis_message
  before insert or update of archive_body, body_kind, view_once
  on public.messages
  for each row
  execute function public.enforce_recoverable_aegis_message();

create or replace function public.enforce_valid_personal_message_archive()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.is_supported_aegis_archive(new.archive_body, new.message_id) then
    raise exception 'AEGIS_ARCHIVE_INVALID'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_valid_personal_message_archive on public.message_archives;
create trigger enforce_valid_personal_message_archive
  before insert or update of archive_body, message_id
  on public.message_archives
  for each row
  execute function public.enforce_valid_personal_message_archive();

comment on function public.is_supported_aegis_archive(text, uuid) is
  'Validates an opaque Aegis archive v2 ciphertext and its immutable message context.';
comment on function public.enforce_recoverable_aegis_message() is
  'Rejects ordinary Aegis messages that cannot be recovered after local browser data loss.';
