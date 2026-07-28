begin;

-- A browser/OS fingerprint is metadata, not a cryptographic device identity.
-- Sesame requires a DeviceID to remain bound to one logical installation.
-- Reclaiming an ID from UA/screen/timezone similarities can merge two real
-- devices and route encrypted copies to the wrong private key.
drop function if exists public.resolve_device_id_by_fingerprints(text[], text);

commit;
