-- Arrêt ciblé de la collecte : conserve les journaux et ne touche pas aux clés,
-- appareils, sessions ou messages. Mettre AEGIS_JOURNEY_ENABLED=false également.
begin;
drop trigger if exists aegis_journey_devices on public.user_devices;
drop trigger if exists aegis_journey_enrollment on public.device_enrollment_challenges;
drop trigger if exists aegis_journey_login on public.login_security_events;
drop trigger if exists aegis_journey_email on public.email_send_log;
drop trigger if exists aegis_journey_messages on public.messages;
drop trigger if exists aegis_journey_errors on public.crypto_error_logs;
revoke execute on function public.record_aegis_request_event(uuid,text,integer,text,integer) from authenticated;
revoke execute on function aegis_observability.record_request(uuid,text,integer,text,integer) from authenticated;
commit;
