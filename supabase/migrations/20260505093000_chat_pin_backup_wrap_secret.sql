-- High-entropy server half for chat-PIN wrapped E2EE backups.
-- The value is returned only by the rate-limited verify-chat-pin edge function
-- after a successful PIN check. It is never readable by authenticated clients.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

ALTER TABLE public.user_chat_pins
ADD COLUMN IF NOT EXISTS backup_wrap_secret text;

UPDATE public.user_chat_pins
SET backup_wrap_secret = encode(gen_random_bytes(32), 'base64')
WHERE backup_wrap_secret IS NULL;

ALTER TABLE public.user_chat_pins
ALTER COLUMN backup_wrap_secret SET NOT NULL;
