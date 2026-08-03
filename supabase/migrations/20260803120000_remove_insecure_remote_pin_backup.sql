-- A six-digit PIN has at most 1,000,000 values. Releasing a ciphertext wrapped
-- directly by such a PIN turns an online rate limit into an offline attack.
-- Aegis now uses PINs only as device-local application locks. Remote recovery
-- remains available through the password-derived account backup or a random
-- high-entropy recovery key.

BEGIN;

DROP FUNCTION IF EXISTS public.release_backup_pin_blob(uuid);
DROP FUNCTION IF EXISTS public.reset_backup_pin_attempts(uuid);
DROP FUNCTION IF EXISTS public.consume_backup_pin_attempt(uuid);
DROP FUNCTION IF EXISTS public.has_backup_pin(uuid);

DROP TABLE IF EXISTS public.backup_pin_state;
DROP FUNCTION IF EXISTS public.touch_backup_pin_state_updated_at();

COMMIT;
