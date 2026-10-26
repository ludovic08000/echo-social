
-- Une intention persistante par commande. Pas de TTL : une réponse transporteur perdue
-- ne prouve pas que l'étiquette n'a pas été facturée/créée.
create table public.marketplace_shipment_claims (
  order_id uuid primary key references public.orders(id),
  claim_id uuid not null unique,
  requested_by uuid not null,
  state text not null default 'reserved' check(state in('reserved','completed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
alter table public.marketplace_shipment_claims enable row level security;
revoke all on public.marketplace_shipment_claims from public,anon,authenticated;
grant select,insert,update on public.marketplace_shipment_claims to service_role;

create function public.claim_marketplace_shipment(p_order uuid,p_caller uuid,p_claim uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_order public.orders%rowtype; v_inserted uuid;
begin
  if p_order is null or p_caller is null or p_claim is null then raise exception 'INVALID_SHIPMENT_CLAIM';end if;
  select * into v_order from public.orders where id=p_order for update;
  if not found or not exists(select 1 from public.order_items i join public.seller_profiles s on s.id=i.seller_id
    where i.order_id=p_order and s.user_id=p_caller) then raise exception 'SHIPMENT_OWNER_REQUIRED';end if;
  if v_order.payment_verified_at is null or v_order.status::text not in('paid','processing','shipped','delivered') then
    raise exception 'VERIFIED_PAYMENT_REQUIRED';end if;
  if nullif(v_order.tracking_number,'') is not null then
    return jsonb_build_object('claimed',false,'tracking_number',v_order.tracking_number,'label_url',v_order.shipping_label_url);
  end if;
  insert into public.marketplace_shipment_claims(order_id,claim_id,requested_by)
    values(p_order,p_claim,p_caller) on conflict(order_id) do nothing returning claim_id into v_inserted;
  return jsonb_build_object('claimed',v_inserted is not null,'reconciliation_required',v_inserted is null);
end $$;
revoke all on function public.claim_marketplace_shipment(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_marketplace_shipment(uuid,uuid,uuid) to service_role;

create function public.complete_marketplace_shipment(p_order uuid,p_claim uuid,p_tracking text,p_label text,p_weight integer)
returns boolean language plpgsql security invoker set search_path='' as $$
declare v_order public.orders%rowtype;v_claim public.marketplace_shipment_claims%rowtype;
begin
  if p_tracking is null or p_tracking !~ '^[A-Za-z0-9-]{6,40}$' or p_weight is null or p_weight<=0 then
    raise exception 'INVALID_SHIPMENT_RESULT';end if;
  -- Même ordre de verrous que la réservation.
  select * into v_order from public.orders where id=p_order for update;
  if not found then raise exception 'SHIPMENT_ORDER_MISSING';end if;
  select * into v_claim from public.marketplace_shipment_claims where order_id=p_order for update;
  if not found or v_claim.claim_id<>p_claim then raise exception 'SHIPMENT_CLAIM_MISMATCH';end if;
  if nullif(v_order.tracking_number,'') is not null and v_order.tracking_number<>p_tracking then
    raise exception 'SHIPMENT_RESULT_CONFLICT';end if;
  if v_claim.state='completed' then return v_order.tracking_number=p_tracking;end if;
  update public.orders set tracking_number=p_tracking,shipping_label_url=p_label,shipping_weight_grams=p_weight,
    shipped_at=coalesce(shipped_at,now()),
    status=case when status::text in('paid','processing') then 'shipped' else status end
    where id=p_order;
  update public.marketplace_shipment_claims set state='completed',completed_at=now() where order_id=p_order;
  return true;
end $$;
revoke all on function public.complete_marketplace_shipment(uuid,uuid,text,text,integer) from public,anon,authenticated;
grant execute on function public.complete_marketplace_shipment(uuid,uuid,text,text,integer) to service_role;

-- Remplace l'ancienne écriture générale orders du tableau vendeur, sans réouvrir
-- les colonnes financières au navigateur ni livrer les articles d'une autre boutique.
create function public.mark_seller_order_delivered(p_order uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=(select auth.uid());v_order public.orders%rowtype;v_count integer;v_all boolean;
begin
  if v_actor is null then raise exception 'NOT_AUTHENTICATED' using errcode='42501';end if;
  select * into v_order from public.orders where id=p_order for update;
  if not found or not exists(select 1 from public.order_items i join public.seller_profiles s on s.id=i.seller_id
    where i.order_id=p_order and s.user_id=v_actor) then raise exception 'SHIPMENT_OWNER_REQUIRED' using errcode='42501';end if;
  if v_order.payment_verified_at is null or v_order.status::text not in('paid','processing','shipped','delivered') then
    raise exception 'VERIFIED_PAYMENT_REQUIRED';end if;
  update public.order_items i set status='delivered' from public.seller_profiles s
    where i.order_id=p_order and s.id=i.seller_id and s.user_id=v_actor
    and i.status::text in('paid','processing','shipped');
  get diagnostics v_count=row_count;
  select not exists(select 1 from public.order_items where order_id=p_order and status::text<>'delivered') into v_all;
  if v_all then update public.orders set status='delivered',delivered_at=coalesce(delivered_at,now()) where id=p_order;end if;
  return jsonb_build_object('updated_items',v_count,'order_delivered',v_all);
end $$;
revoke all on function public.mark_seller_order_delivered(uuid) from public,anon;
grant execute on function public.mark_seller_order_delivered(uuid) to authenticated;
