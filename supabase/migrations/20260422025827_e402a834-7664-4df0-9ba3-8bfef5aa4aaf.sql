-- 1. Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Add embedding columns (768 dims = Gemini text-embedding-004)
ALTER TABLE public.ml_post_features 
  ADD COLUMN IF NOT EXISTS embedding vector(768),
  ADD COLUMN IF NOT EXISTS embedding_updated_at timestamptz;

ALTER TABLE public.ml_user_profiles 
  ADD COLUMN IF NOT EXISTS embedding vector(768),
  ADD COLUMN IF NOT EXISTS embedding_updated_at timestamptz;

-- 3. HNSW indexes for fast cosine similarity search
CREATE INDEX IF NOT EXISTS idx_ml_post_features_embedding 
  ON public.ml_post_features 
  USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_ml_user_profiles_embedding 
  ON public.ml_user_profiles 
  USING hnsw (embedding vector_cosine_ops);

-- 4. Hybrid scoring v2: classic score + semantic similarity
CREATE OR REPLACE FUNCTION public.ml_score_post_v2(p_user_id uuid, p_post_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_classic_score NUMERIC;
  v_semantic_score NUMERIC := 0.5;
  v_user_emb vector(768);
  v_post_emb vector(768);
  v_similarity NUMERIC;
BEGIN
  -- Get classic hybrid score (collab + content + temporal + quality)
  v_classic_score := public.ml_score_post(p_user_id, p_post_id);

  -- Get embeddings
  SELECT embedding INTO v_user_emb FROM ml_user_profiles WHERE user_id = p_user_id;
  SELECT embedding INTO v_post_emb FROM ml_post_features WHERE post_id = p_post_id;

  -- Compute semantic similarity if both embeddings exist
  IF v_user_emb IS NOT NULL AND v_post_emb IS NOT NULL THEN
    -- Cosine similarity: 1 - cosine_distance, normalized to [0, 1]
    v_similarity := 1 - (v_user_emb <=> v_post_emb);
    v_semantic_score := GREATEST(0.0, LEAST(1.0, (v_similarity + 1) / 2.0));
  END IF;

  -- Blend 50/50 classic + semantic
  RETURN LEAST(1.0, GREATEST(0.0, v_classic_score * 0.5 + v_semantic_score * 0.5));
END;
$$;

-- 5. Find top-N semantically similar posts for a user (vector search)
CREATE OR REPLACE FUNCTION public.ml_find_similar_posts(
  p_user_id uuid, 
  p_limit integer DEFAULT 50
)
RETURNS TABLE(post_id uuid, similarity numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_emb vector(768);
BEGIN
  SELECT embedding INTO v_user_emb FROM ml_user_profiles WHERE user_id = p_user_id;
  
  IF v_user_emb IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT 
    pf.post_id,
    (1 - (pf.embedding <=> v_user_emb))::numeric as similarity
  FROM ml_post_features pf
  WHERE pf.embedding IS NOT NULL
  ORDER BY pf.embedding <=> v_user_emb
  LIMIT p_limit;
END;
$$;