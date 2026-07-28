-- PostgREST can retain the former seven-argument registration signature for a
-- short time after the Sesame/Aegis migration. Force its schema cache to see
-- the ten-argument per-device identity RPC immediately.
do $$
begin
  if to_regprocedure(
    'public.register_user_device_safe(uuid,text,text,text,text,text,text,text,text,integer)'
  ) is null then
    raise exception
      'AEGIS_SCHEMA_INCOMPLETE: apply 20260728100000_sesame_per_device_identity.sql first';
  end if;
end;
$$;

notify pgrst, 'reload schema';
