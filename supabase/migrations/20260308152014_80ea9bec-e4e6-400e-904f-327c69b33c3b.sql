-- Break RLS recursion between orders <-> order_items using SECURITY DEFINER helpers

create or replace function public.can_view_order_item(_order_id uuid, _seller_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (
    exists (
      select 1
      from public.orders o
      where o.id = _order_id
        and o.buyer_id = auth.uid()
    )
    or exists (
      select 1
      from public.seller_profiles sp
      where sp.id = _seller_id
        and sp.user_id = auth.uid()
    )
  );
$$;

create or replace function public.can_view_order(_order_id uuid, _buyer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (
    _buyer_id = auth.uid()
    or exists (
      select 1
      from public.order_items oi
      join public.seller_profiles sp on sp.id = oi.seller_id
      where oi.order_id = _order_id
        and sp.user_id = auth.uid()
    )
  );
$$;

-- Rebuild SELECT policies without table-cross-recursion

drop policy if exists "Buyers can view their order items" on public.order_items;
drop policy if exists "Sellers can view their order items" on public.order_items;

create policy "Users can view related order items"
on public.order_items
for select
to authenticated
using (public.can_view_order_item(order_id, seller_id));

-- Keep existing UPDATE/INSERT policies as-is

drop policy if exists "Sellers can view orders containing their items" on public.orders;
drop policy if exists "Users can view their orders" on public.orders;

create policy "Users can view related orders"
on public.orders
for select
to authenticated
using (public.can_view_order(id, buyer_id));