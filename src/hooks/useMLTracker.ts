import { useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { isAnalyticsEnabled } from "@/lib/privacyPreferences";
import { FeedEventQueue, dwellSignal } from "@/lib/feedTelemetry";
import type { FeedSignalType } from "@/lib/recsysV8";
import { emitFeedPerformanceMetric } from './useFeedPerformance';

const queue = new FeedEventQueue();
const exposures = new Map<string, string>();
let queuedUser: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let failures = 0;

function schedule(delay = 1500) {
  if (timer || !queue.size) return;
  timer = setTimeout(() => { timer = null; void flush(); }, delay);
}

async function flush() {
  if (queue.busy) return;
  if (!queuedUser || !isAnalyticsEnabled(queuedUser)) { queue.clear(); return; }
  const owner = queuedUser;
  const success = await queue.flush(async (events) => {
    const { data, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) throw sessionError;
    if (data.session?.user.id !== owner || queuedUser !== owner || !isAnalyticsEnabled(owner)) return;
    const { error } = await supabase.rpc("ml_ingest_feed_events" as never, { p_events: events } as never);
    if (error) throw error;
  });
  failures = success ? 0 : failures + 1;
  if (failures >= 6) { queue.clear(); failures = 0; return; }
  schedule(success ? 0 : Math.min(60000, 1500 * 2 ** failures));
}

export function trackMLSignal(
  userId: string | null, postId: string, signal: FeedSignalType,
  extra?: { dwell_ms?: number; scroll_depth?: number; exposure_id?: string },
) {
  if (!userId || !postId || !isAnalyticsEnabled(userId)) return;
  const exposure = extra?.exposure_id || exposures.get(postId);
  // Search/profile/video surfaces cannot contaminate the feed experiment.
  if (!exposure || window.location.pathname !== '/feed') return;
  if (['like', 'comment', 'share', 'click', 'save'].includes(signal)) {
    emitFeedPerformanceMetric('engagement_action', 1, { action: signal });
  }
  if (queuedUser !== userId) { queue.clear(); queuedUser = userId; failures = 0; }
  queue.push({
    event_id: crypto.randomUUID(), post_id: postId, exposure_id: exposure, event_type: signal,
    ...(Number.isFinite(extra?.dwell_ms)
      ? { dwell_ms: Math.max(0, Math.min(600000, Math.round(extra!.dwell_ms!))) } : {}),
  });
  schedule();
}

export function useMLViewTracker(postId: string, exposureId?: string | null) {
  const { user } = useAuth();
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !user?.id || !postId || !exposureId) return;
    exposures.set(postId, exposureId);
    let visible = false;
    let entered: number | null = null;
    let viewed = false;
    let viewTimer: ReturnType<typeof setTimeout> | null = null;
    const emit = (signal: FeedSignalType, dwell?: number) =>
      trackMLSignal(user.id, postId, signal, { dwell_ms: dwell, exposure_id: exposureId });
    const leave = () => {
      if (viewTimer) clearTimeout(viewTimer);
      viewTimer = null;
      if (entered === null) return;
      const dwell = performance.now() - entered;
      entered = null;
      if (!viewed && dwell >= 1000) { viewed = true; emit('view'); }
      const signal = dwellSignal(dwell);
      if (signal) emit(signal, dwell);
    };
    const update = () => {
      if (visible && document.visibilityState === 'visible') {
        if (entered !== null) return;
        entered = performance.now();
        if (!viewed) viewTimer = setTimeout(() => {
          if (entered !== null && document.visibilityState === 'visible') { viewed = true; emit('view'); }
        }, 1000);
      } else leave();
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting && entry.intersectionRatio >= 0.5;
      update();
    }, { threshold: [0, 0.5, 1] });
    observer.observe(el);
    document.addEventListener('visibilitychange', update);
    window.addEventListener('pagehide', leave);
    return () => {
      leave();
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('pagehide', leave);
      if (exposures.get(postId) === exposureId) exposures.delete(postId);
    };
  }, [postId, exposureId, user?.id]);
  return ref;
}

export function useMLActions(postId: string) {
  const { user } = useAuth();
  const track = useCallback((signal: FeedSignalType, extra?: { dwell_ms?: number; scroll_depth?: number }) => {
    trackMLSignal(user?.id ?? null, postId, signal, extra);
  }, [user?.id, postId]);
  return { track };
}

if (typeof window !== 'undefined') {
  // Let mounted cards enqueue their final foreground dwell before flushing.
  window.addEventListener('pagehide', () => { queueMicrotask(() => { void flush(); }); });
  window.addEventListener('online', () => { failures = 0; schedule(0); });
}
