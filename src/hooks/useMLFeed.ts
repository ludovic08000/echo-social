import { useCallback, useRef, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { useQuery } from '@tanstack/react-query';

type SignalType = 'view' | 'dwell' | 'scroll_past' | 'like' | 'comment' | 'share' | 'click_profile' | 'save';

interface TrackOptions {
  value?: number;
  metadata?: Record<string, any>;
}

// Batched signal tracking — collects signals and sends in bulk
const signalQueue: Array<{
  post_id: string;
  signal_type: SignalType;
  value: number;
  metadata: Record<string, any>;
}> = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function flushSignals() {
  if (signalQueue.length === 0) return;
  const batch = signalQueue.splice(0, signalQueue.length);
  
  try {
    await supabase.functions.invoke('ml-feed', {
      body: { action: 'track', post_id: batch[0].post_id, signal_type: batch[0].signal_type, value: batch[0].value, metadata: batch[0].metadata },
    });
    // Send remaining in parallel (max 5 at a time)
    const rest = batch.slice(1);
    for (let i = 0; i < rest.length; i += 5) {
      await Promise.all(
        rest.slice(i, i + 5).map(s =>
          supabase.functions.invoke('ml-feed', {
            body: { action: 'track', ...s },
          }).catch(() => {})
        )
      );
    }
  } catch {}
}

function queueSignal(postId: string, signalType: SignalType, opts?: TrackOptions) {
  signalQueue.push({
    post_id: postId,
    signal_type: signalType,
    value: opts?.value ?? 1,
    metadata: opts?.metadata ?? {},
  });
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushSignals, 3000);
}

/**
 * Hook to track user behavior signals for ML feed personalization.
 * Signals are batched and sent every 3 seconds.
 */
export function useMLTracking() {
  const { user } = useAuth();
  const dwellTimers = useRef<Map<string, number>>(new Map());
  const viewedPosts = useRef<Set<string>>(new Set());

  // Flush on unmount
  useEffect(() => {
    return () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushSignals();
    };
  }, []);

  const trackView = useCallback((postId: string, metadata?: Record<string, any>) => {
    if (!user || viewedPosts.current.has(postId)) return;
    viewedPosts.current.add(postId);
    queueSignal(postId, 'view', { metadata });
  }, [user]);

  const startDwell = useCallback((postId: string) => {
    if (!user) return;
    dwellTimers.current.set(postId, Date.now());
  }, [user]);

  const endDwell = useCallback((postId: string, metadata?: Record<string, any>) => {
    if (!user) return;
    const start = dwellTimers.current.get(postId);
    if (!start) return;
    const dwellMs = Date.now() - start;
    dwellTimers.current.delete(postId);
    if (dwellMs > 500) { // Only track meaningful dwell (>500ms)
      queueSignal(postId, 'dwell', { value: dwellMs, metadata });
    }
  }, [user]);

  const trackInteraction = useCallback((postId: string, type: SignalType, metadata?: Record<string, any>) => {
    if (!user) return;
    queueSignal(postId, type, { metadata });
  }, [user]);

  return { trackView, startDwell, endDwell, trackInteraction };
}

/**
 * Hook to get AI-powered scores for a set of post IDs.
 * Returns ML scores that can be blended with the local algorithm.
 */
export function useMLScoring(postIds: string[]) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['ml-scores', postIds.slice(0, 10).join(',')],
    queryFn: async () => {
      if (!user || postIds.length === 0) return { scores: {} };
      
      const { data, error } = await supabase.functions.invoke('ml-feed', {
        body: { action: 'score', post_ids: postIds },
      });
      
      if (error) {
        console.warn('ML scoring unavailable:', error.message);
        return { scores: {} };
      }
      
      return data as { scores: Record<string, number>; profile_summary?: any };
    },
    enabled: !!user && postIds.length > 0,
    staleTime: 5 * 60_000, // 5 minutes
    retry: false, // Don't retry ML scoring — degrade gracefully
  });
}

/**
 * Hook to get AI-powered discovery recommendations.
 */
export function useMLRecommendations() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['ml-recommendations', user?.id],
    queryFn: async () => {
      if (!user) return { recommended_post_ids: [] };
      
      const { data, error } = await supabase.functions.invoke('ml-feed', {
        body: { action: 'recommend' },
      });
      
      if (error) {
        console.warn('ML recommendations unavailable:', error.message);
        return { recommended_post_ids: [] };
      }
      
      return data as { recommended_post_ids: string[]; discovery_pool_size: number };
    },
    enabled: !!user,
    staleTime: 10 * 60_000, // 10 minutes
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
  // Normalize ML score (0-100) to match local score range (~0-200)
  const normalizedMl = (mlScore / 100) * 200;
  return localScore * (1 - mlWeight) + normalizedMl * mlWeight;
}
