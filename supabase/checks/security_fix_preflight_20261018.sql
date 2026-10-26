-- Verification de compatibilite seulement. Executer dans Lovable Cloud avant les migrations du lot.
begin transaction read only;
do $$
declare required text; entry record;
begin
  foreach required in array array['orders','order_items','products','seller_profiles','negotiations','cart_items','notifications',
    'friendships','messages','conversations','conversation_participants','user_message_blocks','posts','profiles','privacy_settings',
    'fan_subscriptions','ads','ai_agents','ai_agent_usage','ai_agent_conversations','ai_agent_messages','creator_subscriptions',
    'ai_moderation_cache','ai_learned_rules','live_streams','edge_rate_limits','login_attempts','feed_feature_jobs','ml_post_features',
    'e2ee_transparency_log','e2ee_kt_tree_heads','e2ee_kt_leaves','e2ee_kt_signing_keys',
    'comments','content_strikes','comment_moderation_alerts','feed_algorithm_config','user_roles'] loop
    if to_regclass('public.'||required) is null then raise exception 'MISSING_TABLE:%',required;end if;
  end loop;
  for entry in select * from (values
    ('fan_subscriptions','creator_id'),('fan_subscriptions','fan_id'),('fan_subscriptions','current_period_end'),
    ('fan_subscriptions','status'),('conversations','is_group'),('posts','publish_at'),('posts','expires_at'),
    ('negotiations','seller_profile_id'),('negotiations','order_id'),('ads','moderation_status'),('ads','moderation_reason'),
    ('edge_rate_limits','key'),('edge_rate_limits','window_start'),('edge_rate_limits','count'),('orders','tracking_number'),
    ('orders','shipping_label_url'),('orders','shipping_weight_grams'),('orders','shipped_at'),('orders','delivered_at'),
    ('order_items','status'),('seller_profiles','user_id'),('ai_agents','free_messages_per_day'),('ai_agents','is_active'),
    ('ai_agent_conversations','agent_id'),('ai_agent_conversations','user_id'),('ai_agent_messages','conversation_id'),
    ('creator_subscriptions','user_id'),('creator_subscriptions','status'),('creator_subscriptions','current_period_end'),
    ('privacy_settings','ai_data_sharing_enabled'),('privacy_settings','ai_personalization_enabled'),
    ('privacy_settings','posts_visibility'),('privacy_settings','profile_visibility'),('ml_post_features','embedding'),
    ('feed_feature_jobs','revision'),('feed_feature_jobs','lease_until'),('feed_feature_jobs','attempts'),
    ('comments','id'),('comments','user_id'),('comments','post_id'),('comments','parent_id'),('comments','body'),('comments','is_zeus_reply'),
    ('content_strikes','user_id'),('content_strikes','acknowledged_at'),('comment_moderation_alerts','reviewed_by'),('comment_moderation_alerts','reviewed_at'),
    ('feed_algorithm_config','key'),('feed_algorithm_config','value'),('feed_algorithm_config','updated_by'),('user_roles','role')
  ) as required_columns(table_name,column_name) loop
    if not exists(select 1 from information_schema.columns c where c.table_schema='public'
      and c.table_name=entry.table_name and c.column_name=entry.column_name) then
      raise exception 'MISSING_COLUMN:%.%',entry.table_name,entry.column_name;end if;
  end loop;
  if to_regprocedure('public.assert_current_login_session_approved()') is null then raise exception 'MISSING_SESSION_APPROVAL_GUARD';end if;
  if to_regprocedure('public.decrement_product_stock(uuid,integer)') is null then raise exception 'MISSING_STOCK_GUARD';end if;
  if to_regprocedure('public.feed_eligible_post_ids_internal(uuid,uuid[])') is null then raise exception 'MISSING_FEED_ELIGIBILITY';end if;
  if to_regprocedure('public.check_rate_limit(text,integer,integer)') is null then raise exception 'MISSING_DISTRIBUTED_QUOTA';end if;
  if to_regprocedure('public.can_view_order(uuid,uuid)') is null then raise exception 'MISSING_ORDER_VISIBILITY';end if;
  if to_regclass('aegis_observability.journey_events') is null then raise exception 'MISSING_ADMIN_JOURNEY';end if;
  if not exists(select 1 from pg_roles where rolname='supabase_auth_admin') then raise exception 'MISSING_AUTH_SERVER_ROLE';end if;
end $$;
select table_name,privilege_type,grantee from information_schema.table_privileges
  where table_schema='public' and table_name in('orders','order_items','live_streams','seller_profiles','ai_agents')
  and grantee in('anon','authenticated','PUBLIC') order by table_name,grantee,privilege_type;
-- Les anciens lots partiels ne sont ni supprimés ni « réparés » avec une nouvelle autorité improvisée.
select h.epoch,h.leaf_count as expected_leaves,count(l.log_id) as stored_leaves,
  count(l.log_id) filter(where e.included_in_epoch is distinct from h.epoch or e.leaf_hash is distinct from l.leaf_hash) as inconsistent_annotations
  from public.e2ee_kt_tree_heads h left join public.e2ee_kt_leaves l on l.epoch=h.epoch
  left join public.e2ee_transparency_log e on e.id=l.log_id group by h.epoch,h.leaf_count
  having count(l.log_id)<>h.leaf_count or count(l.log_id) filter(where e.included_in_epoch is distinct from h.epoch or e.leaf_hash is distinct from l.leaf_hash)>0;
select id as signing_key_with_private_material from public.e2ee_kt_signing_keys where public_key_jwk->'d' is not null;
-- Historique à revoir, sans suppression ou changement automatique des auteurs.
select id,post_id,user_id from public.comments where is_zeus_reply=true and user_id is not null;
select c.id,c.post_id,c.parent_id from public.comments c join public.comments p on p.id=c.parent_id where c.post_id is distinct from p.post_id;
select key,jsonb_typeof(value) as value_type from public.feed_algorithm_config
  where key in('scoring_weights','recency_tiers','time_of_day','velocity','marketplace_injection','anti_spam');
-- Contrôler ces dépendances avant d'utiliser la suppression administrative. Ne pas
-- transformer automatiquement les rétentions en cascades pour forcer une suppression.
select conrelid::regclass as dependent_table, confrelid::regclass as referenced_table,
  conname, pg_get_constraintdef(oid) as definition
  from pg_constraint where contype='f' and confrelid in('auth.users'::regclass,'public.profiles'::regclass)
  order by conrelid::regclass::text,conname;
rollback;
