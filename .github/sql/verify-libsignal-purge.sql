select
  (select count(*)::integer from public.messages) as messages,
  (select count(*)::integer from public.message_device_copies) as message_device_copies,
  (select count(*)::integer from public.device_copy_retry_requests) as device_copy_retry_requests,
  (select count(*)::integer from public.aegis_device_inbox) as aegis_device_inbox,
  (select count(*)::integer from public.message_archives) as message_archives,
  (select count(*)::integer from public.aegis_view_once_consumptions) as aegis_view_once_consumptions,
  (select count(*)::integer from public.aegis_view_once_payloads) as aegis_view_once_payloads,
  (select count(*)::integer from public.message_deletions) as message_deletions,
  (select count(*)::integer from public.message_reactions) as message_reactions,
  (select count(*)::integer from public.message_device_retry_requests) as message_device_retry_requests,
  (select count(*)::integer from public.user_devices) as user_devices,
  (select count(*)::integer from public.device_libsignal_prekey_bundles) as libsignal_bundles,
  (
    select count(distinct (bundle.user_id, bundle.device_id))::integer
    from public.device_libsignal_prekey_bundles bundle
  ) as libsignal_bundle_devices,
  (
    select count(distinct bundle.user_id)::integer
    from public.device_libsignal_prekey_bundles bundle
  ) as libsignal_bundle_users,
  (
    select count(*)::integer
    from public.user_devices device
    where device.revoked_at is null
      and not exists (
        select 1
        from public.device_libsignal_prekey_bundles bundle
        where bundle.user_id = device.user_id
          and bundle.device_id = device.device_id
      )
  ) as devices_missing_bundle,
  (
    select count(*)::integer
    from public.user_devices device
    where device.revoked_at is null
      and not exists (
        select 1
        from public.device_libsignal_prekey_bundles bundle
        where bundle.user_id = device.user_id
          and bundle.device_id = device.device_id
      )
      and (
        device.routing_status <> 'repairing'
        or device.routing_error <> 'LIBSIGNAL_BUNDLE_REQUIRED'
      )
  ) as invalid_repair_routes,
  (select count(*)::integer from public.profiles) as profiles,
  (select count(*)::integer from public.conversations) as conversations,
  (select count(*)::integer from public.conversation_participants) as conversation_participants,
  (select count(*)::integer from public.friendships) as friendships,
  (select count(*)::integer from public.posts) as posts,
  (select count(*)::integer from public.user_backups) as user_backups,
  (select count(*)::integer from public.user_crypto_state) as user_crypto_state,
  (select count(*)::integer from public.user_public_keys) as user_public_keys,
  to_regclass('public.device_signed_prekeys') is null as no_device_signed_prekeys,
  to_regclass('public.device_one_time_prekeys') is null as no_device_one_time_prekeys,
  to_regclass('public.user_signed_prekeys') is null as no_user_signed_prekeys,
  to_regclass('public.device_prekey_repair_requests') is null as no_device_prekey_repair_requests,
  to_regclass('public.aegis_x3dh_initial_replay') is null as no_aegis_x3dh_initial_replay,
  to_regclass('public.x3dh_replay_ledger') is null as no_x3dh_replay_ledger,
  exists (
    select 1
    from pg_constraint constraint_record
    where constraint_record.conrelid = 'public.message_device_copies'::regclass
      and constraint_record.conname = 'message_device_copies_libsignal_wire_check'
      and constraint_record.contype = 'c'
      and constraint_record.convalidated = true
  ) as libsignal_wire_constraint_validated,
  (
    pg_get_functiondef(to_regprocedure('public.get_sesame_device_list(uuid)'))
      ilike '%device_libsignal_prekey_bundles%'
    and pg_get_functiondef(to_regprocedure('public.get_sesame_device_list(uuid)'))
      not ilike '%device_signed_prekeys%'
  ) as sesame_is_libsignal_only,
  (
    pg_get_functiondef(to_regprocedure('public.revoke_user_device(text)'))
      ilike '%device_libsignal_prekey_bundles%'
    and not (
      pg_get_functiondef(to_regprocedure('public.revoke_user_device(text)'))
      ilike any (array[
        '%device_signed_prekeys%',
        '%device_one_time_prekeys%',
        '%user_signed_prekeys%'
      ])
    )
  ) as revoke_is_libsignal_only,
  (
    select count(*)::integer
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = any (array[
        'aegis_verify_signed_prekey',
        'bump_device_keys_epoch',
        'cancel_x3dh_initial',
        'claim_device_one_time_prekey',
        'claim_x3dh_initial',
        'cleanup_expired_device_prekeys',
        'consume_device_prekey_repair_requests',
        'count_device_one_time_prekeys',
        'finalize_x3dh_initial',
        'get_current_device_prekey_inventory',
        'get_device_prekey_bundle',
        'get_signed_prekey',
        'get_signed_prekey_with_fallback',
        'publish_device_one_time_prekeys',
        'publish_device_one_time_prekeys_pre_signal_validation',
        'publish_device_signed_prekey',
        'publish_device_signed_prekey_pre_signal_validation',
        'quarantine_ghost_e2ee_devices',
        'quarantine_own_invalid_device_spk',
        'request_device_prekey_repair',
        'reserve_x3dh_initial'
      ])
  ) as legacy_functions,
  (
    select count(*)::integer
    from cron.job job
    where job.command ilike '%cleanup_expired_device_prekeys%'
       or job.command ilike '%device_one_time_prekeys%'
  ) as legacy_cron_jobs;
