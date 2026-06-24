-- ============================================================================
-- C (complet) — archive chiffrée par destinataire pour les messages REÇUS.
--
-- La colonne messages.archive_body (write-once) n'est écrivable que par
-- l'émetteur, donc elle ne couvre que les messages ENVOYÉS. Cette table permet
-- à CHAQUE utilisateur d'archiver sa propre copie déchiffrée (chiffrée sous SA
-- clé d'archive dérivée de sa master key), pour récupérer les messages REÇUS
-- après purge de cache / rotation d'appareil / éviction iOS ITP.
--
-- RLS : chacun ne lit/écrit QUE sa propre ligne (user_id = auth.uid()).
-- Aucune fuite : la ligne d'un utilisateur est illisible par l'autre.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.message_archives (
  message_id  uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  archive_body text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

ALTER TABLE public.message_archives ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ma_select_own" ON public.message_archives;
CREATE POLICY "ma_select_own" ON public.message_archives
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "ma_insert_own" ON public.message_archives;
CREATE POLICY "ma_insert_own" ON public.message_archives
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
-- Write-once: no UPDATE/DELETE policy (client inserts with ignoreDuplicates).
