import { useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { useQuery } from '@tanstack/react-query';

/**
 * ⚠️ DEPRECATED TRACKING — Pipeline unification (2026-04)
 *
 * Tracking is now centralized in `useMLTracker.ts` which writes to
 * `ml_interactions` (single source of truth for SQL ranking + ML training).
 *
 * The previous double-pipeline (this file → user_behavior_signals,
 * useMLTracker → ml_interactions) has been collapsed onto ml_interactions.
 *
 * `useMLTracking` here is now a no-op shim kept only for backward
 * compatibility with legacy call sites. Prefer `useMLViewTracker`
 * and `useMLActions` from `useMLTracker.ts`.
 */
export function useMLTracking() {
  const trackView = useCallback((_postId: string, _metadata?: Record<string, any>) => {
    // no-op: see useMLTracker.useMLViewTracker
  }, []);
  const startDwell = useCallback((_postId: string) => {}, []);
  const endDwell = useCallback((_postId: string, _metadata?: Record<string, any>) => {}, []);
  const trackInteraction = useCallback(
    (_postId: string, _type: string, _metadata?: Record<string, any>) => {},
    []
  );
  return { trackView, startDwell, endDwell, trackInteraction };
}

/**
 * Hook to get AI-powered scores for a set of post IDs.
 * Now uses the unified SQL batch function `ml_pareto_score_batch`.
 */
export function useMLScoring(postIds: string[]) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['ml-scores', postIds.slice(0, 10).join(',')],
    queryFn: async () => {
      if (!user || postIds.length === 0) return { scores: {} as Record<string, number> };

      const { data, error } = await supabase.rpc('ml_pareto_score_batch' as any, {
        p_user_id: user.id,
        p_post_ids: postIds,
      });

      if (error || !Array.isArray(data)) {
        return { scores: {} as Record<string, number> };
      }

      const scores: Record<string, number> = {};
      for (const row of data as Array<{ post_id: string; score: number }>) {
        scores[row.post_id] = Number(row.score) || 0.5;
      }
      return { scores };
    },
    enabled: !!user && postIds.length > 0,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * Hook to get AI-powered discovery recommendations.
 * Still routed through the ml-feed edge function for now (uses ml_interactions).
 */
export function useMLRecommendations() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['ml-recommendations', user?.id],
    queryFn: async () => {
      if (!user) return { recommended_post_ids: [] as string[] };

      const { data, error } = await supabase.functions.invoke('ml-feed', {
        body: { action: 'recommend' },
      });

      if (error) {
        return { recommended_post_ids: [] as string[] };
      }

      return data as { recommended_post_ids: string[]; discovery_pool_size?: number };
    },
    enabled: !!user,
    staleTime: 10 * 60_000,
    retry: false,
  });
}

/**
 * Blend ML scores with local algorithm scores.
 * ML weight increases as more behavior data is available.
 */
export function blendScores(
  localScore: number,
  mlScore: number | undefined,
  mlWeight: number = 0.3
): number {
  if (mlScore === undefined) return localScore;
  // ml_pareto_score_batch returns scores in 0..1 range — normalize to local scale (~0..200)
  const normalizedMl = mlScore * 200;
  return localScore * (1 - mlWeight) + normalizedMl * mlWeight;
}
