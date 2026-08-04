-- Invariant corrigé : la révocation d'un appareil doit invalider immédiatement
-- le cache client des routes de fan-out (auparavant périmé jusqu'à 30 s).
alter table public.user_devices replica identity full;
alter table public.user_device_signatures replica identity full;
alter table public.signed_device_lists replica identity full;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='user_devices') then
    alter publication supabase_realtime add table public.user_devices;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='user_device_signatures') then
    alter publication supabase_realtime add table public.user_device_signatures;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='signed_device_lists') then
    alter publication supabase_realtime add table public.signed_device_lists;
  end if;
end $$;