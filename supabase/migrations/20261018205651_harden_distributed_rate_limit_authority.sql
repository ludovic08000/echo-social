begin;

-- Un quota est une décision atomique partagée, pas un cache par instance ni un succès de secours.
create or replace function public.check_rate_limit(p_key text,p_max_requests integer,p_window_seconds integer)
returns boolean language plpgsql security invoker set search_path='' as $$
declare v_now timestamptz:=clock_timestamp();v_count integer;
begin
  if p_key is null or length(p_key) not between 1 and 512
    or p_max_requests is null or p_max_requests not between 1 and 1000000
    or p_window_seconds is null or p_window_seconds not between 1 and 86400 then
    raise exception 'INVALID_RATE_LIMIT_PARAMETERS' using errcode='22023';
  end if;
  insert into public.edge_rate_limits(key,window_start,count) values(p_key,v_now,1)
  on conflict(key) do update set
    window_start=case when public.edge_rate_limits.window_start<=v_now-make_interval(secs=>p_window_seconds)
      then v_now else public.edge_rate_limits.window_start end,
    count=case when public.edge_rate_limits.window_start<=v_now-make_interval(secs=>p_window_seconds)
      then 1 else least(public.edge_rate_limits.count::bigint+1,2147483647)::integer end
  returning count into v_count;
  return v_count<=p_max_requests;
end $$;

revoke all on function public.check_rate_limit(text,integer,integer) from public,anon,authenticated;
grant execute on function public.check_rate_limit(text,integer,integer) to service_role;
revoke all on public.edge_rate_limits from public,anon,authenticated;
grant select,insert,update,delete on public.edge_rate_limits to service_role;
commit;
