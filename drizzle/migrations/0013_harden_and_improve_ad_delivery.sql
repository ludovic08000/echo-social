drop policy if exists "Paid active campaigns are viewable by everyone" on public.ad_campaigns;
drop policy if exists "Active ads are viewable by everyone" on public.ad_campaigns;
drop policy if exists "Approved paid ads publicly visible" on public.ads;
drop policy if exists "Approved active ads publicly visible" on public.ads;

revoke execute on function public.is_ad_set_paid_and_active(uuid) from public, anon;
grant execute on function public.is_ad_set_paid_and_active(uuid) to service_role;

alter table public.ad_interactions
  add column if not exists ad_id uuid references public.ads(id) on delete cascade,
  add column if not exists placement text,
  add column if not exists interaction_day date not null default current_date;

alter table public.ad_interactions
  drop constraint if exists ad_interactions_type_check;
alter table public.ad_interactions
  add constraint ad_interactions_type_check
  check (interaction_type in ('impression', 'click')) not valid;

alter table public.ad_interactions
  drop constraint if exists ad_interactions_placement_check;
alter table public.ad_interactions
  add constraint ad_interactions_placement_check
  check (placement is null or placement in ('feed', 'stories', 'reels', 'live', 'marketplace', 'sidebar')) not valid;

create index if not exists ad_interactions_ad_idx
  on public.ad_interactions(ad_id, created_at desc)
  where ad_id is not null;

create unique index if not exists ad_interactions_daily_unique_idx
  on public.ad_interactions(user_id, ad_id, interaction_type, interaction_day)
  where ad_id is not null;

drop policy if exists "Users can create interactions" on public.ad_interactions;
revoke insert, update, delete on public.ad_interactions from authenticated;

drop policy if exists "Advertisers can insert stats" on public.ad_daily_stats;
drop policy if exists "Advertisers can update stats" on public.ad_daily_stats;
drop policy if exists "Creator advertisers insert stats" on public.ad_daily_stats;
drop policy if exists "Creator advertisers update stats" on public.ad_daily_stats;
revoke insert, update, delete on public.ad_daily_stats from authenticated;

create or replace function public.get_active_ads_for_placement(
  p_placement text default 'feed',
  p_limit integer default 12
)
returns table (
  id uuid,
  headline text,
  primary_text text,
  image_url text,
  video_url text,
  cta_text text,
  cta_url text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    ad.id,
    ad.headline,
    ad.primary_text,
    ad.image_url,
    ad.video_url,
    coalesce(ad.cta_text, 'En savoir plus') as cta_text,
    ad.cta_url
  from public.ads as ad
  join public.ad_sets as ad_set
    on ad_set.id = ad.ad_set_id
  join public.ad_campaigns as campaign
    on campaign.id = ad_set.campaign_id
  left join public.profiles as viewer
    on viewer.user_id = (select auth.uid())
  where (select auth.uid()) is not null
    and p_placement in ('feed', 'stories', 'reels', 'live', 'marketplace', 'sidebar')
    and p_placement = any(ad_set.placements)
    and ad.advertiser_id <> (select auth.uid())
    and campaign.status = 'active'
    and campaign.paid_at is not null
    and campaign.starts_at <= pg_catalog.now()
    and campaign.ends_at > pg_catalog.now()
    and ad_set.status = 'active'
    and ad_set.starts_at <= pg_catalog.now()
    and ad_set.ends_at > pg_catalog.now()
    and ad.status = 'active'
    and ad.moderation_status = 'approved'
    and (
      viewer.date_of_birth is null
      or extract(year from pg_catalog.age(current_date, viewer.date_of_birth))
        between coalesce(ad_set.target_age_min, 13) and coalesce(ad_set.target_age_max, 65)
    )
    and (
      coalesce(pg_catalog.cardinality(ad_set.target_interests), 0) = 0
      or coalesce(viewer.interests, array[]::text[]) && ad_set.target_interests
    )
    and (
      ad_set.target_location is null
      or pg_catalog.jsonb_typeof(ad_set.target_location) <> 'object'
      or not (ad_set.target_location ? 'villes')
      or pg_catalog.jsonb_typeof(ad_set.target_location -> 'villes') <> 'array'
      or pg_catalog.jsonb_array_length(ad_set.target_location -> 'villes') = 0
      or coalesce(viewer.city, '') in (
        select pg_catalog.jsonb_array_elements_text(ad_set.target_location -> 'villes')
      )
    )
  order by
    ad.impressions asc,
    pg_catalog.md5(ad.id::text || ':' || (select auth.uid())::text || ':' || current_date::text)
  limit least(greatest(coalesce(p_limit, 12), 1), 30);
$$;

revoke all on function public.get_active_ads_for_placement(text, integer) from public, anon;
grant execute on function public.get_active_ads_for_placement(text, integer) to authenticated, service_role;

create or replace function public.track_ad_interaction(
  p_ad_id uuid,
  p_kind text,
  p_placement text default 'feed'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_campaign_id uuid;
  v_inserted integer := 0;
  v_new_lifetime_reach boolean := false;
  v_impression_delta integer := 0;
  v_click_delta integer := 0;
  v_lifetime_reach_delta integer := 0;
  v_daily_reach_delta integer := 0;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  if p_kind not in ('impression', 'click') then
    raise exception 'INVALID_AD_INTERACTION' using errcode = '22023';
  end if;

  if p_placement not in ('feed', 'stories', 'reels', 'live', 'marketplace', 'sidebar') then
    raise exception 'INVALID_AD_PLACEMENT' using errcode = '22023';
  end if;

  select ad_set.campaign_id
  into v_campaign_id
  from public.ads as ad
  join public.ad_sets as ad_set
    on ad_set.id = ad.ad_set_id
  join public.ad_campaigns as campaign
    on campaign.id = ad_set.campaign_id
  left join public.profiles as viewer
    on viewer.user_id = v_user_id
  where ad.id = p_ad_id
    and ad.advertiser_id <> v_user_id
    and p_placement = any(ad_set.placements)
    and campaign.status = 'active'
    and campaign.paid_at is not null
    and campaign.starts_at <= pg_catalog.now()
    and campaign.ends_at > pg_catalog.now()
    and ad_set.status = 'active'
    and ad_set.starts_at <= pg_catalog.now()
    and ad_set.ends_at > pg_catalog.now()
    and ad.status = 'active'
    and ad.moderation_status = 'approved'
    and (
      viewer.date_of_birth is null
      or extract(year from pg_catalog.age(current_date, viewer.date_of_birth))
        between coalesce(ad_set.target_age_min, 13) and coalesce(ad_set.target_age_max, 65)
    )
    and (
      coalesce(pg_catalog.cardinality(ad_set.target_interests), 0) = 0
      or coalesce(viewer.interests, array[]::text[]) && ad_set.target_interests
    )
    and (
      ad_set.target_location is null
      or pg_catalog.jsonb_typeof(ad_set.target_location) <> 'object'
      or not (ad_set.target_location ? 'villes')
      or pg_catalog.jsonb_typeof(ad_set.target_location -> 'villes') <> 'array'
      or pg_catalog.jsonb_array_length(ad_set.target_location -> 'villes') = 0
      or coalesce(viewer.city, '') in (
        select pg_catalog.jsonb_array_elements_text(ad_set.target_location -> 'villes')
      )
    )
  limit 1;

  if v_campaign_id is null then
    raise exception 'AD_NOT_DELIVERABLE' using errcode = '42501';
  end if;

  if p_kind = 'impression' then
    select not exists (
      select 1
      from public.ad_interactions
      where ad_id = p_ad_id
        and user_id = v_user_id
        and interaction_type = 'impression'
    ) into v_new_lifetime_reach;
  end if;

  insert into public.ad_interactions (
    campaign_id,
    ad_id,
    user_id,
    interaction_type,
    placement,
    interaction_day
  ) values (
    v_campaign_id,
    p_ad_id,
    v_user_id,
    p_kind,
    p_placement,
    current_date
  )
  on conflict do nothing;

  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return false;
  end if;

  v_impression_delta := case when p_kind = 'impression' then 1 else 0 end;
  v_click_delta := case when p_kind = 'click' then 1 else 0 end;
  v_lifetime_reach_delta := case when v_new_lifetime_reach then 1 else 0 end;
  v_daily_reach_delta := case when p_kind = 'impression' then 1 else 0 end;

  update public.ads
  set impressions = impressions + v_impression_delta,
      clicks = clicks + v_click_delta,
      reach = reach + v_lifetime_reach_delta,
      updated_at = pg_catalog.now()
  where id = p_ad_id;

  update public.ad_campaigns
  set impressions = impressions + v_impression_delta,
      clicks = clicks + v_click_delta,
      reach = reach + v_lifetime_reach_delta,
      updated_at = pg_catalog.now()
  where id = v_campaign_id;

  insert into public.ad_daily_stats (
    campaign_id,
    stat_date,
    impressions,
    clicks,
    reach,
    spent
  ) values (
    v_campaign_id,
    current_date,
    v_impression_delta,
    v_click_delta,
    v_daily_reach_delta,
    0
  )
  on conflict (campaign_id, stat_date) do update
  set impressions = public.ad_daily_stats.impressions + excluded.impressions,
      clicks = public.ad_daily_stats.clicks + excluded.clicks,
      reach = public.ad_daily_stats.reach + excluded.reach;

  return true;
end;
$$;

revoke all on function public.track_ad_interaction(uuid, text, text) from public, anon;
grant execute on function public.track_ad_interaction(uuid, text, text) to authenticated, service_role;

create or replace function public.enforce_ad_metrics_server_only()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_trusted boolean :=
    coalesce(auth.role(), '') = 'service_role'
    or current_user in ('postgres', 'supabase_admin');
begin
  if not v_trusted and (
    new.impressions is distinct from old.impressions
    or new.clicks is distinct from old.clicks
    or new.reach is distinct from old.reach
    or new.spent is distinct from old.spent
  ) then
    raise exception 'AD_METRICS_SERVER_ONLY' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_ad_metrics_server_only() from public, anon, authenticated;

drop trigger if exists enforce_ad_campaign_metrics_server_only on public.ad_campaigns;
create trigger enforce_ad_campaign_metrics_server_only
before update on public.ad_campaigns
for each row execute function public.enforce_ad_metrics_server_only();

drop trigger if exists enforce_ad_metrics_server_only on public.ads;
create trigger enforce_ad_metrics_server_only
before update on public.ads
for each row execute function public.enforce_ad_metrics_server_only();