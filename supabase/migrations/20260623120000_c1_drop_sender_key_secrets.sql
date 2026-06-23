-- ============================================================================
-- Security audit fix C1 — Sender Key secret material must never be server-side.
--
-- The `sender_key_state` table previously stored:
--   * chain_key_b64    : the 32-byte symmetric chain key. It derives EVERY
--                        group message key, so anyone able to read this column
--                        (the server, the service role, a DB breach) could
--                        decrypt all Sender Key (group) messages.
--   * signing_priv_jwk : the owner's PRIVATE signing key, allowing forgery of
--                        group messages from any sender.
--
-- This defeats end-to-end encryption for group conversations. The client now
-- keeps this material exclusively on-device (IndexedDB `forsure-sender-key-state`,
-- see src/lib/crypto/senderKeyLocalStore.ts). The server keeps only NON-secret
-- presence metadata (ids, is_owner, the PUBLIC signing key, the iteration
-- counter) for ownership signalling and the rotation watcher.
--
-- This migration removes the secret columns. It is destructive by design:
-- existing rows lose key material, which is correct — clients regenerate /
-- re-bootstrap their local chains and re-fan SKDMs on the next send.
-- ============================================================================

ALTER TABLE public.sender_key_state DROP COLUMN IF EXISTS chain_key_b64;
ALTER TABLE public.sender_key_state DROP COLUMN IF EXISTS signing_priv_jwk;
