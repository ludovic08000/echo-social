-- Emergency quarantine for known invalid device SPKs observed in production logs.
-- These device ids still appear as active but their device SPK signatures no
-- longer verify against the active account signing key, so senders repeatedly
-- try and reject their X3DH bundles.
--
-- Safe effect:
--   - disables these stale routing ids for the affected account
--   - disables their active/last-resort device SPKs
--   - does not touch the current valid device, account identity, or messages

update public.device_signed_prekeys
set is_active = false,
    is_last_resort = false
where user_id = 'ffeb378a-e1b3-4bfb-8c31-72c94e4da14d'::uuid
  and device_id in (
    '52adb13ff236ae5c833c9d9049c0df71',
    'b166de502d729356dcbd6c0b5b1a39b0',
    '49cfdeab59355de3051925b4f09fba75',
    '92585130870cedf210af1019379dbc61',
    '450c0cd9af35813c8a99ec5bc0f39ab8'
  );

update public.user_devices
set is_active = false,
    updated_at = now()
where user_id = 'ffeb378a-e1b3-4bfb-8c31-72c94e4da14d'::uuid
  and device_id in (
    '52adb13ff236ae5c833c9d9049c0df71',
    'b166de502d729356dcbd6c0b5b1a39b0',
    '49cfdeab59355de3051925b4f09fba75',
    '92585130870cedf210af1019379dbc61',
    '450c0cd9af35813c8a99ec5bc0f39ab8'
  );
