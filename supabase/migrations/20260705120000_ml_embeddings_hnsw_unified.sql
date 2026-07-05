-- =====================================================================
-- Unification des index vectoriels (256d) : ivfflat -> HNSW
-- =====================================================================
--
-- ⚠️  RELIRE AVANT D'APPLIQUER. Écrite hors-ligne, NON testée contre la DB.
--     Nécessite pgvector >= 0.5.0 (HNSW). Vérifier :
--       SELECT extversion FROM pg_extension WHERE extname='vector';
--     Appliquer en STAGING d'abord.
--
-- Contexte (recsys v8)
-- --------------------
-- Le retrieval multi-source (ml_retrieve_feed_candidates_v8) et le scoring
-- (ml_score_post_v4) s'appuient sur des recherches de plus proches voisins
-- cosinus (<=>) sur trois tables d'embeddings 256d :
--     ml_user_embeddings, ml_post_embeddings, ml_creator_features.
-- Ces trois étaient indexées en ivfflat, qui :
--   - se dégrade silencieusement quand la table grossit (partitions figées
--     calculées sur peu de données) -> mauvais rappel à l'échelle,
--   - doit être reconstruit périodiquement pour rester bon.
-- HNSW (graphe hiérarchique navigable) : meilleur rappel, reste bon quand la
-- table grandit sans reconstruction. C'est le choix par défaut moderne pour la
-- reco à grande échelle -> le vrai "préparer à des millions".
--
-- NB: les embeddings 768d (ml_post_features / ml_user_profiles) sont DÉJÀ en
-- HNSW (migration 20260422025827) -> rien à faire pour eux.
--
-- Non destructif : chaque nouvel index HNSW est créé AVANT le drop de l'ancien
-- ivfflat. Idempotent (IF NOT EXISTS / IF EXISTS).
--
-- Paramètres HNSW : m=16, ef_construction=64 (défauts pgvector). Augmenter
-- ef_construction (100-200) améliore le rappel au prix d'un build plus lent.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. ml_user_embeddings (User Tower, 256d)
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ml_user_emb_hnsw
  ON public.ml_user_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

DROP INDEX IF EXISTS public.idx_ml_user_emb_vector;

-- ---------------------------------------------------------------------
-- 2. ml_post_embeddings (Item Tower, 256d)
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ml_post_emb_hnsw
  ON public.ml_post_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

DROP INDEX IF EXISTS public.idx_ml_post_emb_vector;

-- ---------------------------------------------------------------------
-- 3. ml_creator_features (Creator Tower, 256d) — nouveau en recsys v8
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ml_creator_features_hnsw
  ON public.ml_creator_features
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

DROP INDEX IF EXISTS public.idx_ml_creator_features_embedding;

-- =====================================================================
-- NOTE — build sans bloquer les écritures (grosses tables en prod)
-- =====================================================================
-- Les CREATE INDEX ci-dessus prennent un lock ACCESS EXCLUSIVE pendant le
-- build. Si une table est déjà volumineuse, préférer la variante CONCURRENTLY,
-- à lancer MANUELLEMENT (hors migration transactionnelle), une par une :
--
--   CREATE INDEX CONCURRENTLY idx_ml_creator_features_hnsw
--     ON public.ml_creator_features USING hnsw (embedding vector_cosine_ops);
--   DROP INDEX CONCURRENTLY idx_ml_creator_features_embedding;
--
-- CONCURRENTLY ne peut pas tourner dans un bloc BEGIN/COMMIT.
-- =====================================================================
