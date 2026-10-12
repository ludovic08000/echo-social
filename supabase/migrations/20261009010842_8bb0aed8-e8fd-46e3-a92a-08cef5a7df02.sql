create table if not exists public.news_reactions (
  thread_id uuid not null references public.news_threads(id) on delete cascade,
  user_id uuid not null,
  reaction text not null check (reaction in ('like','love','haha','wow','sad','angry')),
  created_at timestamptz not null default now(),
  primary key (thread_id, user_id)
);

alter table public.news_reactions enable row level security;

create policy news_reactions_select on public.news_reactions
  for select to authenticated using (true);
create policy news_reactions_insert on public.news_reactions
  for insert to authenticated with check (user_id = auth.uid());
create policy news_reactions_update on public.news_reactions
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy news_reactions_delete on public.news_reactions
  for delete to authenticated using (user_id = auth.uid());

create or replace function public.get_news_reactions(p_thread uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'counts', coalesce((
      select jsonb_object_agg(reaction, n)
      from (select reaction, count(*)::int as n from public.news_reactions where thread_id = p_thread group by reaction) c
    ), '{}'::jsonb),
    'mine', (select reaction from public.news_reactions where thread_id = p_thread and user_id = auth.uid())
  );
$$;

create or replace function public.set_news_reaction(p_thread uuid, p_reaction text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.news_reactions (thread_id, user_id, reaction)
  values (p_thread, auth.uid(), p_reaction)
  on conflict (thread_id, user_id) do update set reaction = excluded.reaction;
$$;

create or replace function public.remove_news_reaction(p_thread uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.news_reactions where thread_id = p_thread and user_id = auth.uid();
$$;

revoke all on function public.get_news_reactions(uuid) from public, anon;
revoke all on function public.set_news_reaction(uuid, text) from public, anon;
revoke all on function public.remove_news_reaction(uuid) from public, anon;
grant execute on function public.get_news_reactions(uuid) to authenticated;
grant execute on function public.set_news_reaction(uuid, text) to authenticated;
grant execute on function public.remove_news_reaction(uuid) to authenticated;