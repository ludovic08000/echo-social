-- Appliquer seulement après vérification du client utilisant LIVE_PUBLIC_COLUMNS et my_seller_profile.
-- Un droit SELECT de table ne peut pas être retiré en révoquant seulement ses colonnes.
do $$ declare t text; cols text; excluded text; begin
  foreach t in array array['live_streams','seller_profiles','ai_agents'] loop
    excluded:=case t when 'live_streams' then 'stream_key' when 'seller_profiles' then 'total_revenue' else 'system_prompt' end;
    execute format('revoke select on table public.%I from public,anon,authenticated',t);
    execute format('revoke select (%I) on table public.%I from public,anon,authenticated',excluded,t);
    select string_agg(quote_ident(attname),',' order by attnum) into cols from pg_attribute
      where attrelid=format('public.%I',t)::regclass and attnum>0 and not attisdropped and attname<>excluded;
    execute format('grant select (%s) on table public.%I to anon,authenticated',cols,t);
  end loop;
end $$;
