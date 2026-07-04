-- =====================================================================
-- Encrypted session sync — durable off-device ratchet backups
-- =====================================================================
--
-- ⚠️  REVIEW BEFORE APPLYING. Authored offline, NOT run against a live DB.
--     Verify against current schema and run in staging first.
--
-- Stores CLIENT-SIDE-ENCRYPTED ratchet state so a WKWebView IndexedDB purge
-- (iOS) no longer loses the session. The server only ever sees opaque
-- ciphertext + IV: blobs are encrypted with the account Master Key
-- (getSessionMasterKey), which is wrapped by the passkey/PIN vault and never
-- uploaded. RLS restricts every row to its owner as defense-in-depth.
--
-- One row per (user_id, device_id, conversation_id, kind); kind is 'session'
-- (current live ratchet) or 'archive' (bounded previous sessions). Rows are
-- overwritten, never appended, so we don't accumulate a decryptable history.
--
-- Client: src/lib/crypto/encryptedSessionSync.ts
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.e2ee_session_sync (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  conversation_id text NOT NULL,
  kind text NOT NULL DEFAULT 'session',
  encrypted_blob text NOT NULL,
  iv text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT e2ee_session_sync_kind_chk CHECK (kind IN ('session', 'archive')),
  CONSTRAINT e2ee_session_sync_unique UNIQUE (user_id, device_id, conversation_id, kind)
);

COMMENT ON TABLE public.e2ee_session_sync IS
  'Client-side-encrypted Double Ratchet state backups. Server-blind: encrypted_blob is AES-GCM ciphertext under the account Master Key (never uploaded). Overwritten per (user, device, conversation, kind).';

CREATE INDEX IF NOT EXISTS idx_e2ee_session_sync_lookup
  ON public.e2ee_session_sync(user_id, device_id, conversation_id, kind);

ALTER TABLE public.e2ee_session_sync ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'e2ee_session_sync'
      AND policyname = 'session_sync owner select'
  ) THEN
    CREATE POLICY "session_sync owner select" ON public.e2ee_session_sync
      FOR SELECT USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'e2ee_session_sync'
      AND policyname = 'session_sync owner insert'
  ) THEN
    CREATE POLICY "session_sync owner insert" ON public.e2ee_session_sync
      FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'e2ee_session_sync'
      AND policyname = 'session_sync owner update'
  ) THEN
    CREATE POLICY "session_sync owner update" ON public.e2ee_session_sync
      FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'e2ee_session_sync'
      AND policyname = 'session_sync owner delete'
  ) THEN
    CREATE POLICY "session_sync owner delete" ON public.e2ee_session_sync
      FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;
