-- Hotfix for environments where the transport acceleration migration was
-- deployed without the earlier recoverable-archive migration. The send
-- trigger resolves this helper at execution time, so a missing definition
-- rejects every normal Aegis message with PostgreSQL error 42883.

create or replace function public.is_supported_aegis_archive(
  p_archive_body text,
  p_message_id uuid
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $function$
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
$function$;

comment on function public.is_supported_aegis_archive(text, uuid) is
  'Validates an opaque Aegis archive v2 ciphertext and its immutable message context.';

-- Fail the migration itself if the restored helper accepts a mismatched
-- context or rejects a structurally valid archive.
do $assertion$
declare
  v_message_id constant uuid := '00000000-0000-0000-0000-000000000001';
  v_archive constant text := '{"v":"2","context":"00000000-0000-0000-0000-000000000001","iv":"AAAAAAAAAAAAAAAA","ct":"AAAAAAAAAAAAAAAAAAAAAA=="}';
begin
  if not public.is_supported_aegis_archive(v_archive, v_message_id) then
    raise exception 'AEGIS_ARCHIVE_VALIDATOR_RESTORE_FAILED';
  end if;

  if public.is_supported_aegis_archive(
    v_archive,
    '00000000-0000-0000-0000-000000000002'::uuid
  ) then
    raise exception 'AEGIS_ARCHIVE_VALIDATOR_CONTEXT_CHECK_FAILED';
  end if;
end;
$assertion$;
