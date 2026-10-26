begin;

-- Les déclarations client ne choisissent ni leur place ni leur preuve d'inclusion.
revoke insert,update,delete on public.e2ee_transparency_log from public,anon,authenticated;
grant insert(user_id,event_type,fingerprint,identity_epoch,device_id,payload) on public.e2ee_transparency_log to authenticated;
revoke insert,update,delete on public.e2ee_kt_tree_heads,public.e2ee_kt_leaves,public.e2ee_kt_signing_keys from public,anon,authenticated;

create function public.publish_transparency_epoch(
  p_epoch bigint,p_prev_epoch bigint,p_root text,p_signing_key uuid,p_signature text,p_leaves jsonb
) returns boolean language plpgsql security invoker set search_path='' as $$
declare v_previous bigint;v_count integer;v_hashes text[];v_next text[];v_i integer;v_changed integer;v_row record;
begin
  if p_epoch is null or p_epoch<1 or p_epoch>9007199254740991 or p_root is null or p_root !~ '^[0-9a-f]{64}$'
    or p_signature is null or p_signature !~ '^[0-9a-f]{128}$' or jsonb_typeof(p_leaves) is distinct from 'array' then
    raise exception 'KT_INVALID_EPOCH';end if;
  v_count:=jsonb_array_length(p_leaves);
  if v_count<1 or v_count>5000 then raise exception 'KT_INVALID_LEAF_COUNT';end if;
  if exists(select 1 from jsonb_array_elements(p_leaves) x where jsonb_typeof(x) is distinct from 'object'
    or coalesce(x->>'id','') !~ '^[1-9][0-9]{0,15}$' or coalesce(x->>'hash','') !~ '^[0-9a-f]{64}$') then
    raise exception 'KT_INVALID_LEAF';end if;
  if (select count(distinct x->>'id') from jsonb_array_elements(p_leaves) x)<>v_count then
    raise exception 'KT_DUPLICATE_LEAF';end if;
  -- Un seul éditeur à la fois, puis verrous des entrées dans l'ordre des identifiants.
  perform pg_advisory_xact_lock(182026,14314);
  select max(epoch) into v_previous from public.e2ee_kt_tree_heads;
  if v_previous is distinct from p_prev_epoch or p_epoch<>coalesce(v_previous,0)+1 then
    raise exception 'KT_EPOCH_RACE' using errcode='40001';end if;
  if not exists(select 1 from public.e2ee_kt_signing_keys where id=p_signing_key and active=true and algorithm='Ed25519') then
    raise exception 'KT_SIGNING_KEY_UNAVAILABLE';end if;
  for v_row in select l.id,l.included_in_epoch from public.e2ee_transparency_log l
    join jsonb_array_elements(p_leaves) x on l.id=(x->>'id')::bigint order by l.id for update of l loop
    if v_row.included_in_epoch is not null then raise exception 'KT_LOG_ALREADY_PUBLISHED';end if;
  end loop;
  if (select count(*) from public.e2ee_transparency_log where id in(select (x->>'id')::bigint from jsonb_array_elements(p_leaves) x))<>v_count then
    raise exception 'KT_LOG_MISSING';end if;
  select array_agg(x.value->>'hash' order by x.ordinality) into v_hashes from jsonb_array_elements(p_leaves) with ordinality x;
  -- Conserver exactement la forme historique ForSure, y compris le dernier nœud dupliqué.
  while array_length(v_hashes,1)>1 loop
    v_next:='{}'::text[];v_i:=1;
    while v_i<=array_length(v_hashes,1) loop
      v_next:=array_append(v_next,encode(sha256(decode('01'||v_hashes[v_i]||coalesce(v_hashes[v_i+1],v_hashes[v_i]),'hex')),'hex'));
      v_i:=v_i+2;
    end loop;
    v_hashes:=v_next;
  end loop;
  if v_hashes[1]<>p_root then raise exception 'KT_ROOT_MISMATCH';end if;
  insert into public.e2ee_kt_tree_heads(epoch,root_hash,leaf_count,prev_epoch,signing_key_id,signature)
    values(p_epoch,p_root,v_count,p_prev_epoch,p_signing_key,p_signature);
  insert into public.e2ee_kt_leaves(epoch,leaf_index,log_id,leaf_hash)
    select p_epoch,x.ordinality-1,(x.value->>'id')::bigint,x.value->>'hash' from jsonb_array_elements(p_leaves) with ordinality x;
  update public.e2ee_transparency_log l set included_in_epoch=p_epoch,leaf_hash=x.value->>'hash'
    from jsonb_array_elements(p_leaves) x(value) where l.id=(x.value->>'id')::bigint and l.included_in_epoch is null;
  get diagnostics v_changed=row_count;
  if v_changed<>v_count then raise exception 'KT_LOG_CONFLICT';end if;
  return true;
end $$;
revoke all on function public.publish_transparency_epoch(bigint,bigint,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.publish_transparency_epoch(bigint,bigint,text,uuid,text,jsonb) to service_role;
grant select,insert on public.e2ee_kt_tree_heads,public.e2ee_kt_leaves,public.e2ee_kt_signing_keys to service_role;
grant select,update on public.e2ee_transparency_log to service_role;
commit;
