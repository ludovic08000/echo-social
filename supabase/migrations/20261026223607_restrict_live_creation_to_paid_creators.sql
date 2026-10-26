begin;

update public.creator_subscriptions
set plan = 'creator_essential'
where plan = 'creator_monthly';

-- Only Stripe-backed creator subscriptions may create a live or replay.
-- Reading, joining, chatting, ending and deleting an owned live keep their
-- existing behavior. The payment authority remains the Stripe webhook.
drop policy if exists "Users can create lives" on public.live_streams;
drop policy if exists "Paid creators can create lives" on public.live_streams;

create policy "Paid creators can create lives"
on public.live_streams
for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1
    from public.creator_subscriptions subscription
    where subscription.user_id = (select auth.uid())
      and subscription.status = 'active'
      and subscription.plan in ('creator_essential', 'creator_pro', 'creator_studio')
      and subscription.stripe_subscription_id is not null
      and subscription.current_period_end > now()
  )
);

-- A browser must never be able to manufacture or extend its own paid state.
drop policy if exists "Users can insert their own subscription" on public.creator_subscriptions;
drop policy if exists "Users can update their own subscription" on public.creator_subscriptions;
revoke insert, update, delete on public.creator_subscriptions from anon, authenticated;

commit;
