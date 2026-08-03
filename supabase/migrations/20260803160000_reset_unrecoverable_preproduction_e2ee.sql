-- Correction : la migration de format precedente a supprime les coffres de
-- preproduction. Conserver leurs identites publiques aurait rendu toute
-- recreation locale impossible. Ce reset unique retire ensemble les messages
-- devenus indechiffrables et toutes les anciennes routes cryptographiques.
begin;

-- Les copies et etats derives sont retires avant leurs parents afin que la
-- migration reste deterministe meme si une ancienne base n'a pas tous les FK.
delete from public.message_device_copies;

do $reset_optional$
declare
  v_table text;
begin
  foreach v_table in array array[
    'message_edit_device_copies',
    'message_device_retry_requests',
    'device_copy_retry_requests',
    'device_prekey_repair_requests',
    'e2ee_session_sync',
    'invalid_e2ee_devices',
    'signed_device_lists'
  ] loop
    if to_regclass('public.' || v_table) is not null then
      execute format('delete from public.%I', v_table);
    end if;
  end loop;
end
$reset_optional$;

delete from public.messages;

delete from public.device_one_time_prekeys;
delete from public.device_signed_prekeys;
delete from public.user_devices;
delete from public.user_public_keys;
delete from public.user_backups;

commit;
