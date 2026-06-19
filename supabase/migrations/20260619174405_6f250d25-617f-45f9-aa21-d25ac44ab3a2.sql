create or replace function public.send_message_with_device_copies(
  p_conversation_id uuid,
  p_body text,
  p_image_url text default null,
  p_extra jsonb default '{}'::jsonb,
  p_copies jsonb default '[]'::jsonb
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_message_id uuid;
  v_copies_count int := coalesce(jsonb_array_length(coalesce(p_copies, '[]'::jsonb)), 0);
  v_body_kind text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  if v_copies_count > 0 then
    v_body_kind := 'multi_device';
  else
    v_body_kind := coalesce(nullif(p_extra->>'body_kind', ''), 'legacy');
  end if;

  insert into public.messages (
    conversation_id,
    sender_id,
    body,
    image_url,
    body_kind,
    view_once,
    expires_at,
    document_url,
    document_name,
    document_mime,
    document_size_bytes,
    archive_body
  ) values (
    p_conversation_id,
    v_uid,
    p_body,
    nullif(p_image_url, ''),
    v_body_kind,
    coalesce((p_extra->>'view_once')::boolean, false),
    nullif(p_extra->>'expires_at', '')::timestamptz,
    nullif(p_extra->>'document_url', ''),
    nullif(p_extra->>'document_name', ''),
    nullif(p_extra->>'document_mime', ''),
    nullif(p_extra->>'document_size_bytes', '')::int,
    nullif(p_extra->>'archive_body', '')
  )
  returning id into v_message_id;

  if v_copies_count > 0 then
    insert into public.message_device_copies (
      message_id,
      recipient_user_id,
      recipient_device_id,
      sender_user_id,
      sender_device_id,
      encrypted_body
    )
    select
      v_message_id,
      (c->>'recipient_user_id')::uuid,
      c->>'recipient_device_id',
      v_uid,
      c->>'sender_device_id',
      c->>'encrypted_body'
    from jsonb_array_elements(p_copies) as c
    where (c->>'recipient_user_id') is not null
      and (c->>'recipient_device_id') is not null
      and (c->>'sender_device_id') is not null
      and (c->>'encrypted_body') is not null
    on conflict (message_id, recipient_device_id) do nothing;
  end if;

  return v_message_id;
end
$$;

grant execute on function public.send_message_with_device_copies(uuid, text, text, jsonb, jsonb) to authenticated;