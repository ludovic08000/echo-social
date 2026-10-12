-- Pilote Lovable Cloud isolé uniquement, après la migration de liaison Libsignal.
-- Le corps chiffré reste identique ; les invitations nouvelles exigent la preuve
-- Ed25519. Aucun appel historique, message ou clé privée n'est supprimé.
begin;

create function public.aegis_call_invitation_proof_payload(
  p_call_id uuid, p_conversation_id uuid, p_caller_id uuid, p_caller_device_id text,
  p_call_type text, p_is_group boolean, p_recipient_user_id uuid,
  p_recipient_device_id text, p_unsigned_envelope text
) returns text language sql immutable set search_path=public,pg_temp as $$
  select '{"protocol":"forsure-aegis-call-invitation","callId":' || to_json(p_call_id::text)::text
    || ',"conversationId":' || to_json(p_conversation_id::text)::text
    || ',"callerId":' || to_json(p_caller_id::text)::text
    || ',"callerDeviceId":' || to_json(p_caller_device_id)::text
    || ',"callType":' || to_json(p_call_type)::text
    || ',"isGroup":' || p_is_group::text
    || ',"recipientUserId":' || to_json(p_recipient_user_id::text)::text
    || ',"recipientDeviceId":' || to_json(p_recipient_device_id)::text
    || ',"unsignedEnvelope":' || to_json(p_unsigned_envelope)::text || '}';
$$;
revoke all on function public.aegis_call_invitation_proof_payload(uuid,uuid,uuid,text,text,boolean,uuid,text,text)
  from public,anon,authenticated;

-- Invoker : s'exécute dans la transaction du RPC existant, pas un nouvel accès
-- SECURITY DEFINER exposé. Les clients gardent seulement SELECT sur la table.
create function public.authenticate_aegis_call_invitation() returns trigger
language plpgsql set search_path=public,pg_temp as $$
declare
  v_call public.active_calls%rowtype;
  v_parts text[];
  v_bytes bytea;
  v_key text;
begin
  perform public.assert_current_messaging_client();
  perform public.assert_current_login_session_approved();
  select * into v_call from public.active_calls where id=new.call_id for share;
  if not found or auth.uid() is null or v_call.caller_id is distinct from auth.uid()
    or v_call.protocol_version<>5 or v_call.status not in ('ringing','answered','accepted') then
    raise exception 'CALL_DEVICE_NOT_AUTHORIZED';
  end if;
  if v_call.room_name is distinct from 'call-'||v_call.id::text
    or v_call.call_type not in ('audio','video') or v_call.is_group is null
    or length(v_call.caller_device_id) not between 8 and 200
    or length(new.recipient_device_id) not between 8 and 200
    or new.recipient_device_id is distinct from trim(new.recipient_device_id) then
    raise exception 'CALL_INVITATION_INVALID';
  end if;
  if new.encrypted_call_key is null or length(new.encrypted_call_key)>8192 then
    raise exception 'CALL_INVITATION_INVALID';
  end if;
  v_parts:=string_to_array(new.encrypted_call_key,'.');
  if cardinality(v_parts)=4 and v_parts[1]='aegis-call-v1' then
    raise exception 'CALL_CLIENT_UPDATE_REQUIRED';
  end if;
  if cardinality(v_parts)<>6 or v_parts[1]<>'aegis-call-v1' then
    raise exception 'CALL_INVITATION_INVALID';
  end if;
  for i in 2..6 loop
    v_bytes:=public.aegis_decode_base64(v_parts[i]);
    if v_bytes is null or replace(encode(v_bytes,'base64'),E'\n','') is distinct from v_parts[i]
      or (i=2 and octet_length(v_bytes)<>32) or (i=3 and octet_length(v_bytes)<>12)
      or (i=4 and octet_length(v_bytes)<>60) or (i=6 and octet_length(v_bytes)<>64) then
      raise exception 'CALL_INVITATION_INVALID';
    end if;
  end loop;
  if v_parts[5] is distinct from replace(encode(convert_to(v_call.caller_device_id,'UTF8'),'base64'),E'\n','') then
    raise exception 'CALL_INVITATION_SIGNATURE_INVALID';
  end if;

  select d.device_signing_key into v_key from public.user_devices d
    join lateral (select k.* from public.user_public_keys k where k.user_id=d.user_id and k.is_active
      order by k.created_at desc limit 1) k on true
    where d.user_id=v_call.caller_id and d.device_id=v_call.caller_device_id
      and d.is_active and d.revoked_at is null and d.stale_at is null and d.crypto_invalid_at is null
      and d.approval_status='approved' and d.binding_status='bound' and d.account_bound_at is not null
      and d.routing_status='ready'
      and public.aegis_verify_account_binding(k.identity_key,k.signing_key,k.fingerprint,k.identity_binding_signature,k.identity_binding_version)
      and public.aegis_verify_device_authorization(d.user_id,d.device_id,d.device_public_key,d.device_signing_key,
        d.device_authorization_signature,k.signing_key,k.fingerprint)
    for share of d;
  if v_key is null then raise exception 'CALL_DEVICE_NOT_AUTHORIZED'; end if;
  if public.aegis_verify_ed25519(v_key,v_parts[6],convert_to(public.aegis_call_invitation_proof_payload(
    v_call.id,v_call.conversation_id,v_call.caller_id,v_call.caller_device_id,v_call.call_type,v_call.is_group,
    new.recipient_user_id,new.recipient_device_id,array_to_string(v_parts[1:5],'.')),'UTF8')) is distinct from true then
    raise exception 'CALL_INVITATION_SIGNATURE_INVALID';
  end if;
  return new;
end $$;
revoke all on function public.authenticate_aegis_call_invitation() from public,anon,authenticated;
create trigger aegis_call_invitation_require_proof
  before insert or update of call_id,recipient_user_id,recipient_device_id,encrypted_call_key
  on public.aegis_call_invitations for each row execute function public.authenticate_aegis_call_invitation();

-- Les champs couverts par la signature sont immuables, contrairement au statut.
create function public.keep_aegis_call_context_immutable() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if row(new.id,new.conversation_id,new.caller_id,new.caller_device_id,new.call_type,new.is_group,new.room_name,new.protocol_version)
    is distinct from row(old.id,old.conversation_id,old.caller_id,old.caller_device_id,old.call_type,old.is_group,old.room_name,old.protocol_version) then
    raise exception 'CALL_INVITATION_INVALID';
  end if;
  return new;
end $$;
revoke all on function public.keep_aegis_call_context_immutable() from public,anon,authenticated;
create trigger aegis_call_context_immutable before update on public.active_calls
  for each row execute function public.keep_aegis_call_context_immutable();

commit;
