create or replace function public.has_creator_tool_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1
      from public.profiles as profile
      where profile.user_id = (select auth.uid())
        and profile.is_creator is true
    )
    or public.has_role((select auth.uid()), 'admin'::public.app_role);
$$;

revoke all on function public.has_creator_tool_access() from public, anon;
grant execute on function public.has_creator_tool_access() to authenticated, service_role;

alter table public.ad_campaigns
  add column if not exists paid_at timestamptz;

update public.ad_campaigns
set paid_at = coalesce(paid_at, created_at)
where status in ('active', 'paused', 'ended');

create or replace function public.enforce_ad_campaign_paid_activation()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  trusted_payment_writer boolean :=
    coalesce(auth.role(), '') = 'service_role'
    or current_user in ('postgres', 'supabase_admin');
begin
  if not trusted_payment_writer then
    if tg_op = 'INSERT' and new.paid_at is not null then
      raise exception 'AD_PAYMENT_STATE_SERVER_ONLY' using errcode = '42501';
    end if;

    if tg_op = 'UPDATE' and new.paid_at is distinct from old.paid_at then
      raise exception 'AD_PAYMENT_STATE_SERVER_ONLY' using errcode = '42501';
    end if;

    if new.status = 'active' and new.paid_at is null then
      raise exception 'AD_PAYMENT_REQUIRED' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_ad_campaign_paid_activation() from public, anon, authenticated;

drop trigger if exists enforce_ad_campaign_paid_activation on public.ad_campaigns;
create trigger enforce_ad_campaign_paid_activation
before insert or update on public.ad_campaigns
for each row execute function public.enforce_ad_campaign_paid_activation();

create or replace function public.is_ad_set_paid_and_active(p_ad_set_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.ad_sets
    join public.ad_campaigns
      on ad_campaigns.id = ad_sets.campaign_id
    where ad_sets.id = p_ad_set_id
      and ad_campaigns.status = 'active'
      and ad_campaigns.paid_at is not null
      and ad_campaigns.starts_at <= pg_catalog.now()
      and ad_campaigns.ends_at > pg_catalog.now()
  );
$$;

revoke all on function public.is_ad_set_paid_and_active(uuid) from public;
grant execute on function public.is_ad_set_paid_and_active(uuid) to anon, authenticated, service_role;

drop policy if exists "Advertisers can manage their campaigns" on public.ad_campaigns;
create policy "Creator advertisers manage their campaigns"
on public.ad_campaigns
for all
to authenticated
using (
  advertiser_id = (select auth.uid())
  and public.has_creator_tool_access()
)
with check (
  advertiser_id = (select auth.uid())
  and public.has_creator_tool_access()
);

drop policy if exists "Active ads are viewable by everyone" on public.ad_campaigns;
create policy "Paid active campaigns are viewable by everyone"
on public.ad_campaigns
for select
to authenticated
using (
  status = 'active'
  and paid_at is not null
  and starts_at <= now()
  and ends_at > now()
);

drop policy if exists "Advertiser manages own ad sets" on public.ad_sets;
create policy "Creator advertisers manage own ad sets"
on public.ad_sets
for all
to authenticated
using (
  advertiser_id = (select auth.uid())
  and public.has_creator_tool_access()
)
with check (
  advertiser_id = (select auth.uid())
  and public.has_creator_tool_access()
);

drop policy if exists "Approved active ads publicly visible" on public.ads;
create policy "Approved paid ads publicly visible"
on public.ads
for select
to authenticated, anon
using (
  status = 'active'
  and moderation_status = 'approved'
  and public.is_ad_set_paid_and_active(ad_set_id)
);

drop policy if exists "Advertiser manages own ads" on public.ads;
create policy "Creator advertisers manage own ads"
on public.ads
for all
to authenticated
using (
  advertiser_id = (select auth.uid())
  and public.has_creator_tool_access()
)
with check (
  advertiser_id = (select auth.uid())
  and public.has_creator_tool_access()
);

drop policy if exists "Advertisers can view their ad interactions" on public.ad_interactions;
create policy "Creator advertisers view their ad interactions"
on public.ad_interactions
for select
to authenticated
using (
  public.has_creator_tool_access()
  and exists (
    select 1
    from public.ad_campaigns
    where ad_campaigns.id = ad_interactions.campaign_id
      and ad_campaigns.advertiser_id = (select auth.uid())
  )
);

drop policy if exists "Advertisers can view their stats" on public.ad_daily_stats;
create policy "Creator advertisers view their stats"
on public.ad_daily_stats
for select
to authenticated
using (
  public.has_creator_tool_access()
  and exists (
    select 1
    from public.ad_campaigns
    where ad_campaigns.id = ad_daily_stats.campaign_id
      and ad_campaigns.advertiser_id = (select auth.uid())
  )
);

drop policy if exists "Advertisers can insert stats" on public.ad_daily_stats;
create policy "Creator advertisers insert stats"
on public.ad_daily_stats
for insert
to authenticated
with check (
  public.has_creator_tool_access()
  and exists (
    select 1
    from public.ad_campaigns
    where ad_campaigns.id = ad_daily_stats.campaign_id
      and ad_campaigns.advertiser_id = (select auth.uid())
  )
);

drop policy if exists "Advertisers can update stats" on public.ad_daily_stats;
create policy "Creator advertisers update stats"
on public.ad_daily_stats
for update
to authenticated
using (
  public.has_creator_tool_access()
  and exists (
    select 1
    from public.ad_campaigns
    where ad_campaigns.id = ad_daily_stats.campaign_id
      and ad_campaigns.advertiser_id = (select auth.uid())
  )
)
with check (
  public.has_creator_tool_access()
  and exists (
    select 1
    from public.ad_campaigns
    where ad_campaigns.id = ad_daily_stats.campaign_id
      and ad_campaigns.advertiser_id = (select auth.uid())
  )
);

drop policy if exists "Users can manage their agent conversations" on public.ai_agent_conversations;
create policy "Creators manage their agent conversations"
on public.ai_agent_conversations
for all
to authenticated
using (
  user_id = (select auth.uid())
  and public.has_creator_tool_access()
)
with check (
  user_id = (select auth.uid())
  and public.has_creator_tool_access()
);

drop policy if exists "Users can manage their agent messages" on public.ai_agent_messages;
create policy "Creators manage their agent messages"
on public.ai_agent_messages
for all
to authenticated
using (
  public.has_creator_tool_access()
  and exists (
    select 1
    from public.ai_agent_conversations
    where ai_agent_conversations.id = ai_agent_messages.conversation_id
      and ai_agent_conversations.user_id = (select auth.uid())
  )
)
with check (
  public.has_creator_tool_access()
  and exists (
    select 1
    from public.ai_agent_conversations
    where ai_agent_conversations.id = ai_agent_messages.conversation_id
      and ai_agent_conversations.user_id = (select auth.uid())
  )
);

drop policy if exists "Users can manage their usage" on public.ai_agent_usage;
create policy "Creators manage their agent usage"
on public.ai_agent_usage
for all
to authenticated
using (
  user_id = (select auth.uid())
  and public.has_creator_tool_access()
)
with check (
  user_id = (select auth.uid())
  and public.has_creator_tool_access()
);