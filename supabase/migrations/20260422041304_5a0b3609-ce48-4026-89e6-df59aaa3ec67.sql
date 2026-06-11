-- ============================================
-- Step 2: Align ml_score_post_v4 with intelligent fallback
-- ============================================
CREATE OR REPLACE FUNCTION public.ml_score_post_v4(p_user_id uuid, p_post_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_emb_256 vector;
  v_post_emb_256 vector;
  v_user_emb_768 vector;
  v_post_emb_768 vector;
  v_similarity NUMERIC;
  v_classic_score NUMERIC;
  v_final_score NUMERIC;
BEGIN
  -- Tier 1: Try Two-Tower embeddings (256d) — most accurate when available
  BEGIN
    EXECUTE 'SELECT embedding FROM ml_user_embeddings WHERE user_id = $1 LIMIT 1'
      INTO v_user_emb_256 USING p_user_id;
    EXECUTE 'SELECT embedding FROM ml_post_embeddings WHERE post_id = $1 LIMIT 1'
      INTO v_post_emb_256 USING p_post_id;

    IF v_user_emb_256 IS NOT NULL AND v_post_emb_256 IS NOT NULL THEN
      v_similarity := 1 - (v_user_emb_256 <=> v_post_emb_256);
      v_classic_score := public.ml_score_post_v3(p_user_id, p_post_id);
      -- Blend: 60% neural similarity + 40% classic
      v_final_score := (v_similarity * 0.6) + (v_classic_score * 0.4);
      RETURN LEAST(1.0, GREATEST(0.0, v_final_score));
    END IF;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    -- Tables don't exist yet, fall through
    NULL;
  END;

  -- Tier 2: Try standard 768d embeddings
  BEGIN
    SELECT embedding INTO v_user_emb_768
    FROM ml_user_profiles WHERE user_id = p_user_id LIMIT 1;
    SELECT embedding INTO v_post_emb_768
    FROM ml_post_features WHERE post_id = p_post_id LIMIT 1;

    IF v_user_emb_768 IS NOT NULL AND v_post_emb_768 IS NOT NULL THEN
      v_similarity := 1 - (v_user_emb_768 <=> v_post_emb_768);
      v_classic_score := public.ml_score_post_v3(p_user_id, p_post_id);
      v_final_score := (v_similarity * 0.5) + (v_classic_score * 0.5);
      RETURN LEAST(1.0, GREATEST(0.0, v_final_score));
    END IF;
  EXCEPTION WHEN undefined_column THEN
    NULL;
  END;

  -- Tier 3: Fallback to classic v3 scoring
  RETURN public.ml_score_post_v3(p_user_id, p_post_id);
END;
$$;

-- ============================================
-- Step 3a: Batch scoring function (replaces N+1 RPC calls)
-- ============================================
CREATE OR REPLACE FUNCTION public.ml_pareto_score_batch(
  p_user_id uuid,
  p_post_ids uuid[]
)
RETURNS TABLE(post_id uuid, score numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_post_id uuid;
  v_score numeric;
BEGIN
  IF p_post_ids IS NULL OR array_length(p_post_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  -- Limit batch size to prevent abuse
  IF array_length(p_post_ids, 1) > 200 THEN
    RAISE EXCEPTION 'Batch size exceeds limit (200)';
  END IF;

  FOREACH v_post_id IN ARRAY p_post_ids LOOP
    BEGIN
      v_score := public.ml_score_post_v4(p_user_id, v_post_id);
    EXCEPTION WHEN OTHERS THEN
      -- Graceful fallback per post
      BEGIN
        v_score := public.ml_score_post_v3(p_user_id, v_post_id);
      EXCEPTION WHEN OTHERS THEN
        BEGIN
          v_score := public.ml_score_post(p_user_id, v_post_id);
        EXCEPTION WHEN OTHERS THEN
          v_score := 0.5;
        END;
      END;
    END;

    post_id := v_post_id;
    score := COALESCE(v_score, 0.5);
    RETURN NEXT;
  END LOOP;

  RETURN;
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION public.ml_pareto_score_batch(uuid, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ml_score_post_v4(uuid, uuid) TO authenticated;