begin;

-- Le prix negocie n'est payable qu'apres une decision du vendeur (ou acceptation exacte de sa contre-offre).
create function public.guard_negotiation_authority() returns trigger language plpgsql set search_path='' as $$
declare v_user uuid:=(select auth.uid());v_seller uuid;v_price numeric;
begin
  if current_user in ('postgres','supabase_admin','service_role') then return new; end if;
  if new.offered_price is null or not(new.offered_price between 0.01 and 99999999.99)
    or new.offered_price<>round(new.offered_price,2) then raise exception 'INVALID_OFFER' using errcode='42501'; end if;
  if tg_op='INSERT' then
    select seller_id,price into v_seller,v_price from public.products where id=new.product_id and is_active=true;
    if not found or v_seller is distinct from new.seller_profile_id or new.buyer_id is distinct from v_user
      or new.status<>'pending' or new.counter_price is not null or new.order_id is not null then
      raise exception 'NEGOTIATION_CREATION_FORBIDDEN' using errcode='42501'; end if;
    new.original_price:=v_price;return new;
  end if;
  if new.id is distinct from old.id or new.product_id is distinct from old.product_id
    or new.buyer_id is distinct from old.buyer_id or new.seller_profile_id is distinct from old.seller_profile_id
    or new.conversation_id is distinct from old.conversation_id or new.created_at is distinct from old.created_at
    or new.order_id is distinct from old.order_id or new.original_price is distinct from old.original_price then
    raise exception 'NEGOTIATION_IDENTITY_IMMUTABLE' using errcode='42501'; end if;
  if old.order_id is not null or old.status not in ('pending','counter') then
    raise exception 'NEGOTIATION_ALREADY_DECIDED' using errcode='42501'; end if;
  if old.buyer_id=v_user then
    if new.counter_price is distinct from old.counter_price or not(
      (old.status='counter' and new.status='accepted' and new.offered_price=old.counter_price)
      or (new.status='rejected' and new.offered_price=old.offered_price)) then
      raise exception 'BUYER_CANNOT_APPROVE_OFFER' using errcode='42501'; end if;
  elsif exists(select 1 from public.seller_profiles where id=old.seller_profile_id and user_id=v_user) then
    if new.offered_price is distinct from old.offered_price or new.status not in ('accepted','rejected','counter')
      or (new.status='counter' and (new.counter_price is null or not(new.counter_price between 0.01 and 99999999.99)
        or new.counter_price<>round(new.counter_price,2)))
      or (new.status<>'counter' and new.counter_price is distinct from old.counter_price) then
      raise exception 'INVALID_SELLER_DECISION' using errcode='42501'; end if;
  else raise exception 'FORBIDDEN' using errcode='42501'; end if;
  return new;
end $$;
revoke all on function public.guard_negotiation_authority() from public,anon,authenticated;
create trigger guard_negotiation_authority before insert or update on public.negotiations
  for each row execute function public.guard_negotiation_authority();

-- Conserver les lectures acheteur/vendeur ; aucune écriture financière n'est légitime depuis le client.
revoke insert, update, delete, truncate, references, trigger on public.orders, public.order_items from public, anon, authenticated;
grant select on public.orders, public.order_items to authenticated;
drop policy if exists "Users can create orders" on public.orders;
drop policy if exists "Users can update their pending orders" on public.orders;
drop policy if exists "Buyer can create order items" on public.order_items;
drop policy if exists "System can create order items" on public.order_items;
drop policy if exists "Sellers can update their order items status" on public.order_items;

alter table public.orders add column if not exists stripe_checkout_session_id text;
alter table public.orders add column if not exists stripe_customer_id text;
alter table public.orders add column if not exists payment_verified_at timestamptz;
create unique index if not exists orders_checkout_session_unique on public.orders(stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;

create table public.marketplace_payment_receipts (
  order_id uuid primary key references public.orders(id),
  payment_intent_id text not null unique,
  session_id text not null unique,
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null check (currency = 'eur'),
  verified_at timestamptz not null default now()
);
alter table public.marketplace_payment_receipts enable row level security;
revoke all on public.marketplace_payment_receipts from public, anon, authenticated;
grant all on public.marketplace_payment_receipts to service_role;

-- Transaction unique pour validation, stock, notifications et reçu : un rejeu ne produit jamais une deuxième vente.
create function public.settle_marketplace_payment(
  p_order_id uuid, p_buyer_id uuid, p_session_id text, p_payment_intent_id text,
  p_amount_cents bigint, p_currency text
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  v_order public.orders%rowtype;
  v_item record;
  v_was_pending boolean;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.buyer_id is distinct from p_buyer_id
    or p_currency is distinct from 'eur' or p_amount_cents is null or p_amount_cents <= 0
    or round(v_order.total * 100)::bigint is distinct from p_amount_cents
    or p_session_id is null or p_session_id !~ '^cs_'
    or p_payment_intent_id is null or p_payment_intent_id !~ '^pi_'
    or (v_order.stripe_checkout_session_id is not null and v_order.stripe_checkout_session_id <> p_session_id)
    or (v_order.payment_intent_id is not null and v_order.payment_intent_id <> p_payment_intent_id)
  then raise exception 'PAYMENT_BINDING_MISMATCH' using errcode='42501'; end if;

  if exists(select 1 from public.marketplace_payment_receipts where order_id=p_order_id
    and session_id=p_session_id and payment_intent_id=p_payment_intent_id) then return false; end if;
  if v_order.status::text not in ('pending','paid','processing','shipped','delivered') then
    raise exception 'ORDER_NOT_PAYABLE' using errcode='42501'; end if;
  if not exists(select 1 from public.order_items where order_id=p_order_id) then
    raise exception 'ORDER_ITEMS_REQUIRED'; end if;
  insert into public.marketplace_payment_receipts(order_id,payment_intent_id,session_id,amount_cents,currency)
    values(p_order_id,p_payment_intent_id,p_session_id,p_amount_cents,p_currency);
  v_was_pending := v_order.status::text='pending';

  if v_was_pending then
    -- Ordre de verrouillage stable pour les paniers concurrents contenant les mêmes produits.
    for v_item in select product_id,sum(quantity)::integer as quantity from public.order_items
      where order_id=p_order_id group by product_id order by product_id loop
      if v_item.quantity <= 0 then raise exception 'INVALID_ORDER_QUANTITY'; end if;
      if not public.decrement_product_stock(v_item.product_id,v_item.quantity) then
        raise exception 'INSUFFICIENT_STOCK'; end if;
    end loop;
    update public.order_items set status='paid' where order_id=p_order_id and status='pending';
    insert into public.notifications(user_id,actor_id,type)
      select distinct s.user_id,p_buyer_id,'sale' from public.order_items i
      join public.seller_profiles s on s.id=i.seller_id where i.order_id=p_order_id;
    delete from public.cart_items where user_id=p_buyer_id;
  end if;
  update public.orders set status=case when v_was_pending then 'paid'::public.order_status else status end,
    paid_at=coalesce(paid_at,now()),payment_intent_id=p_payment_intent_id,
    stripe_checkout_session_id=p_session_id,payment_verified_at=now() where id=p_order_id;
  update public.negotiations set status='paid' where order_id=p_order_id and status='accepted';
  return true;
end $$;
revoke all on function public.settle_marketplace_payment(uuid,uuid,text,text,bigint,text) from public,anon,authenticated;
grant execute on function public.settle_marketplace_payment(uuid,uuid,text,text,bigint,text) to service_role;

commit;
