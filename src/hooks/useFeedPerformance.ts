import { useRef, useCallback, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

// Unique session ID per tab
const SESSION_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

interface MetricBatch {
  metric_type: string;
  value: number;
  metadata?: Record<string, unknown>;
}

/**
 * Feed performance collector — Level 1: Observer
 * Tracks load time, scroll depth, posts rendered, engagement, abandonment, FPS
 */
export function useFeedPerformance() {
  const { user } = useAuth();
  const batchRef = useRef<MetricBatch[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollStartRef = useRef<number>(0);
  const maxScrollRef = useRef<number>(0);
  const postsRenderedRef = useRef<number>(0);
  const feedMountTimeRef = useRef<number>(0);
  const interactionsRef = useRef<number>(0);

  // Flush batched metrics to DB
  const flush = useCallback(async () => {
    if (!user || batchRef.current.length === 0) return;
    const items = batchRef.current.splice(0);
    try {
      await supabase.from('feed_performance_metrics').insert(
        items.map(m => ({
          user_id: user.id,
          session_id: SESSION_ID,
          metric_type: m.metric_type,
          value: m.value,
          metadata: m.metadata || {},
        })) as any
      );
    } catch {
      // Silent fail — non-critical telemetry
    }
  }, [user]);

  // Queue a metric (auto-flush every 30s or at 20 items)
  const track = useCallback((type: string, value: number, metadata?: Record<string, unknown>) => {
    batchRef.current.push({ metric_type: type, value, metadata });
    if (batchRef.current.length >= 20) {
      flush();
    }
  }, [flush]);

  // Auto-flush timer
  useEffect(() => {
    flushTimer.current = setInterval(flush, 30_000);
    return () => {
      if (flushTimer.current) clearInterval(flushTimer.current);
      flush(); // flush on unmount
    };
  }, [flush]);

  // ── Track feed load time ──
  const markFeedStart = useCallback(() => {
    feedMountTimeRef.current = performance.now();
  }, []);

  const markFeedReady = useCallback(() => {
    if (feedMountTimeRef.current > 0) {
      const loadTime = Math.round(performance.now() - feedMountTimeRef.current);
      track('load_time', loadTime);
      feedMountTimeRef.current = 0;
    }
  }, [track]);

  // ── Track scroll depth ──
  const trackScroll = useCallback((scrollTop: number, scrollHeight: number) => {
    if (scrollHeight <= 0) return;
    const depth = Math.round((scrollTop / scrollHeight) * 100);
    if (depth > maxScrollRef.current) {
      maxScrollRef.current = depth;
    }
  }, []);

  // ── Track posts rendered ──
  const trackPostsRendered = useCallback((count: number) => {
    if (count > postsRenderedRef.current) {
      postsRenderedRef.current = count;
    }
  }, []);

  // ── Track engagement (likes, comments, shares) ──
  const trackInteraction = useCallback((type: 'like' | 'comment' | 'share' | 'click') => {
    interactionsRef.current++;
    track('engagement_action', 1, { action: type });
  }, [track]);

  // ── Track FPS (sampled) ──
  const measureFPS = useCallback(() => {
    let frameCount = 0;
    let lastTime = performance.now();
    let rafId: number;

    const loop = () => {
      frameCount++;
      const now = performance.now();
      if (now - lastTime >= 2000) { // sample over 2 seconds
        const fps = Math.round((frameCount / (now - lastTime)) * 1000);
        track('fps', fps);
        return; // done
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [track]);

  // ── Flush session summary on page hide ──
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        // Record session summary
        if (maxScrollRef.current > 0) {
          track('scroll_depth', maxScrollRef.current);
        }
        if (postsRenderedRef.current > 0) {
          track('posts_rendered', postsRenderedRef.current);
        }
        if (interactionsRef.current > 0) {
          track('engagement_rate', interactionsRef.current);
        }
        // Abandonment: scroll depth < 15% = likely abandoned
        if (maxScrollRef.current > 0 && maxScrollRef.current < 15) {
          track('abandonment', 1);
        }
        flush();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [track, flush]);

  return {
    markFeedStart,
    markFeedReady,
    trackScroll,
    trackPostsRendered,
    trackInteraction,
    measureFPS,
    track,
  };
}
