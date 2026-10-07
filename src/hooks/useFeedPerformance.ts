import { useRef, useCallback, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { isAnalyticsEnabled } from '@/lib/privacyPreferences';

// Unique session ID per tab
const SESSION_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

interface MetricBatch {
  id?: string;
  metric_type: string;
  value: number;
  metadata?: Record<string, unknown>;
}

export const FEED_PERFORMANCE_EVENT = 'forsure:feed-performance';

export function emitFeedPerformanceMetric(
  metricType: string,
  value: number,
  metadata?: Record<string, unknown>,
) {
  if (typeof window === 'undefined' || !Number.isFinite(value)) return;
  window.dispatchEvent(new CustomEvent(FEED_PERFORMANCE_EVENT, {
    detail: {
      metric_type: metricType,
      value: Math.max(0, Math.round(value)),
      metadata: metadata ?? {},
    } satisfies MetricBatch,
  }));
}

/**
 * Feed performance collector — Level 1: Observer
 * Tracks load time, scroll depth, posts rendered, engagement, abandonment, FPS
 */
export function useFeedPerformance() {
  const { user } = useAuth();
  const batchRef = useRef<MetricBatch[]>([]);
  const busy = useRef(false);
  const failures = useRef(0);
  const owner = useRef(user?.id);
  const raf = useRef<number | null>(null);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxScrollRef = useRef<number>(0);
  const postsRenderedRef = useRef<number>(0);
  const feedMountTimeRef = useRef<number>(0);
  const interactionsRef = useRef<number>(0);
  useEffect(() => {
    owner.current = user?.id;
    batchRef.current = [];
    failures.current = 0;
    maxScrollRef.current = postsRenderedRef.current = interactionsRef.current = 0;
  }, [user?.id]);

  // Flush batched metrics to DB
  const flush = useCallback(async () => {
    if (!user || !isAnalyticsEnabled(user.id) || batchRef.current.length === 0) {
      if (user && !isAnalyticsEnabled(user.id)) batchRef.current = [];
      return;
    }
    if (busy.current) return;
    busy.current = true;
    const items = batchRef.current.splice(0, 100);
    try {
      const session = await supabase.auth.getSession();
      if (session.error) throw session.error;
      if (session.data.session?.user.id !== user.id || owner.current !== user.id || !isAnalyticsEnabled(user.id)) return;
      const { error } = await supabase.from('feed_performance_metrics').upsert(
        items.map(m => ({
          id: m.id,
          user_id: user.id,
          session_id: SESSION_ID,
          metric_type: m.metric_type,
          value: m.value,
          metadata: m.metadata || {},
        })) as any, { onConflict: 'id', ignoreDuplicates: true }
      );
      if (error) throw error;
      failures.current = 0;
    } catch {
      failures.current++;
      if (owner.current === user.id && isAnalyticsEnabled(user.id) && failures.current < 4) {
        batchRef.current = [...items, ...batchRef.current].slice(0, 200);
      }
    } finally { busy.current = false; }
  }, [user]);

  // Queue a metric (auto-flush every 30s or at 20 items)
  const track = useCallback((type: string, value: number, metadata?: Record<string, unknown>) => {
    if (!user?.id || !isAnalyticsEnabled(user.id) || !Number.isFinite(value) || batchRef.current.length >= 200) return;
    batchRef.current.push({ id: crypto.randomUUID(), metric_type: type, value, metadata });
  }, [flush, user?.id]);

  // RPC timings are emitted by the data hook after the response settles. Keep
  // the telemetry on this existing 30-second batch so measurement never adds
  // another request to the feed's critical path.
  useEffect(() => {
    const onMetric = (event: Event) => {
      const detail = (event as CustomEvent<MetricBatch>).detail;
      if (!detail || !Number.isFinite(detail.value)) return;
      if (detail.metric_type === 'engagement_action') interactionsRef.current++;
      track(detail.metric_type, detail.value, detail.metadata);
    };
    window.addEventListener(FEED_PERFORMANCE_EVENT, onMetric);
    return () => window.removeEventListener(FEED_PERFORMANCE_EVENT, onMetric);
  }, [track]);

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
    const depth = Math.min(100, Math.round((scrollTop / scrollHeight) * 100));
    if (depth > maxScrollRef.current) {
      maxScrollRef.current = depth;
    }
  }, []);

  useEffect(() => {
    const onScroll = () => trackScroll(window.scrollY, document.documentElement.scrollHeight - window.innerHeight);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [trackScroll]);

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
    if (document.hidden || raf.current !== null || !user?.id || !isAnalyticsEnabled(user.id)) return;
    let frameCount = 0;
    let lastTime = performance.now();
    let rafId: number;

    const loop = () => {
      if (document.hidden) { raf.current = null; return; }
      frameCount++;
      const now = performance.now();
      if (now - lastTime >= 2000) { // sample over 2 seconds
        const fps = Math.round((frameCount / (now - lastTime)) * 1000);
        track('fps', fps);
        raf.current = null;
        return; // done
      }
      rafId = requestAnimationFrame(loop);
      raf.current = rafId;
    };
    rafId = requestAnimationFrame(loop);
    raf.current = rafId;
    return () => cancelAnimationFrame(rafId);
  }, [track, user?.id]);

  useEffect(() => () => { if (raf.current !== null) cancelAnimationFrame(raf.current); }, []);

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
        if (postsRenderedRef.current > 0) {
          track('abandonment', maxScrollRef.current < 15 && interactionsRef.current === 0 ? 1 : 0);
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
