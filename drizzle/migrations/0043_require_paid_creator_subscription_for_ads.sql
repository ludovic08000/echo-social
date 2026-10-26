create or replace function public.has_creator_tool_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.has_role(auth.uid(), 'admin'::public.app_role)
    or exists (
      select 1
      from public.creator_subscriptions subscription
      where subscription.user_id = auth.uid()
        and subscription.status = 'active'
        and subscription.plan in ('creator_essential', 'creator_pro', 'creator_studio')
        and subscription.stripe_subscription_id is not null
        and subscription.current_period_end > now()
    );
$$;

revoke all on function public.has_creator_tool_access() from public, anon;
grant execute on function public.has_creator_tool_access() to authenticated, service_role;
