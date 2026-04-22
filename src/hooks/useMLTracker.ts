import { useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";

type SignalType =
  | "view"
  | "dwell_long"
  | "like"
  | "comment"
  | "share"
  | "hide"
  | "report"
  | "skip_fast"
  | "click";

const SIGNAL_WEIGHT: Record<SignalType, number> = {
  view: 0.5,
  dwell_long: 1.5,
  like: 2.0,
  comment: 3.0,
  share: 4.0,
  hide: -3.0,
  report: -5.0,
  skip_fast: -1.0,
  click: 1.0,
};

const queue: Array<{ user_id: string; post_id: string; signal_type: SignalType; weight: number; dwell_ms?: number; scroll_depth?: number }> = [];
let flushTimer: number | null = null;

function flushSoon() {
  if (flushTimer) return;
  flushTimer = window.setTimeout(async () => {
    flushTimer = null;
    const batch = queue.splice(0, queue.length);
    if (!batch.length) return;
    const now = new Date();
    const rows = batch.map((b) => ({
      ...b,
      hour_of_day: now.getHours(),
      day_of_week: now.getDay(),
      is_weekend: now.getDay() === 0 || now.getDay() === 6,
    }));
    try {
      await supabase.from("ml_interactions").insert(rows);
    } catch (e) {
      // Silent fail — never block UX for analytics
      console.warn("[ML] Failed to flush interactions", e);
    }
  }, 1500);
}

/**
 * Track a single ML signal for the feed learning engine.
 * Batched & non-blocking.
 */
export function trackMLSignal(
  userId: string | null,
  postId: string,
  signal: SignalType,
  extra?: { dwell_ms?: number; scroll_depth?: number }
) {
  if (!userId || !postId) return;
  queue.push({
    user_id: userId,
    post_id: postId,
    signal_type: signal,
    weight: SIGNAL_WEIGHT[signal] ?? 1,
    dwell_ms: extra?.dwell_ms,
    scroll_depth: extra?.scroll_depth,
  });
  flushSoon();
}

/**
 * Hook to track view + dwell time on a single post card.
 * Usage:
 *   const ref = useMLViewTracker(postId);
 *   <article ref={ref}>...</article>
 */
export function useMLViewTracker(postId: string) {
  const { user } = useAuth();
  const ref = useRef<HTMLElement | null>(null);
  const enterAtRef = useRef<number | null>(null);
  const viewedRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || !user?.id || !postId) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
            if (enterAtRef.current === null) enterAtRef.current = Date.now();
            if (!viewedRef.current) {
              viewedRef.current = true;
              trackMLSignal(user.id, postId, "view");
            }
          } else if (enterAtRef.current !== null) {
            const dwell = Date.now() - enterAtRef.current;
            enterAtRef.current = null;
            if (dwell >= 3000) {
              trackMLSignal(user.id, postId, "dwell_long", { dwell_ms: dwell });
            } else if (dwell < 600 && viewedRef.current) {
              trackMLSignal(user.id, postId, "skip_fast", { dwell_ms: dwell });
            }
          }
        }
      },
      { threshold: [0, 0.5, 1] }
    );

    observer.observe(el);
    return () => {
      observer.disconnect();
      if (enterAtRef.current !== null) {
        const dwell = Date.now() - enterAtRef.current;
        if (dwell >= 3000) trackMLSignal(user.id, postId, "dwell_long", { dwell_ms: dwell });
      }
    };
  }, [postId, user?.id]);

  return ref;
}

/** Convenience helpers for explicit signals. */
export function useMLActions(postId: string) {
  const { user } = useAuth();
  const track = useCallback(
    (signal: SignalType, extra?: { dwell_ms?: number; scroll_depth?: number }) => {
      trackMLSignal(user?.id ?? null, postId, signal, extra);
    },
    [user?.id, postId]
  );
  return { track };
}
