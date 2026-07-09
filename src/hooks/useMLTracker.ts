import { useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { recordSessionSignal } from "@/lib/ml/feedDiversity";
import { buildFeedExperimentEvent, capExperimentEventBatch } from "@/lib/ml/recsysV8";

type SignalType =
  | "view"
  | "dwell_medium"
  | "dwell_long"
  | "watch_complete"
  | "like"
  | "comment"
  | "share"
  | "save"
  | "not_interested"
  | "hide"
  | "report"
  | "skip_fast"
  | "click";

const SIGNAL_WEIGHT: Record<SignalType, number> = {
  view: 0.5,
  dwell_medium: 1.0,
  dwell_long: 1.5,
  watch_complete: 2.2,
  like: 2.0,
  comment: 3.0,
  share: 4.0,
  save: 3.2,
  not_interested: -4.0,
  hide: -3.0,
  report: -5.0,
  skip_fast: -1.0,
  click: 1.0,
};

const POSITIVE_SIGNALS: SignalType[] = ["like", "comment", "share", "save", "dwell_medium", "dwell_long", "watch_complete", "click"];
const NEGATIVE_SIGNALS: SignalType[] = ["hide", "not_interested", "report", "skip_fast"];

type QueuedInteraction = {
  user_id: string;
  post_id: string;
  signal_type: SignalType;
  weight: number;
  dwell_ms?: number;
  scroll_depth?: number;
};

const queue: QueuedInteraction[] = [];
const watchTimeQueue: Array<{ post_id: string; dwell_ms: number }> = [];
let flushTimer: number | null = null;

// Cache post → author for session re-ranking signal feedback (avoids extra round-trips)
const postAuthorCache = new Map<string, string>();
export function cachePostAuthor(postId: string, authorId: string) {
  if (postId && authorId) postAuthorCache.set(postId, authorId);
}

function flushSoon() {
  if (flushTimer) return;
  flushTimer = window.setTimeout(async () => {
    flushTimer = null;
    const batch = queue.splice(0, queue.length);
    const watchBatch = watchTimeQueue.splice(0, watchTimeQueue.length);

    if (batch.length) {
      const rows = batch.map(sanitizeInteraction);
      try {
        const { error } = await supabase.from("ml_interactions").insert(rows);
        if (error) {
          const minimalRows = rows.map(({ user_id, post_id, signal_type, weight }) => ({
            user_id,
            post_id,
            signal_type,
            weight,
          }));
          const { error: fallbackError } = await supabase.from("ml_interactions").insert(minimalRows);
          if (fallbackError) throw fallbackError;
        }

        const experimentEvents = capExperimentEventBatch(
          rows
            .map((row) => buildFeedExperimentEvent({
              postId: row.post_id,
              signal: row.signal_type,
              dwellMs: row.dwell_ms,
              weight: row.weight,
              surface: "feed",
            }))
            .filter(Boolean) as NonNullable<ReturnType<typeof buildFeedExperimentEvent>>[]
        );
        if (experimentEvents.length) {
          void supabase
            .rpc("ml_record_feed_ab_events" as any, { p_events: experimentEvents as any })
            .then(({ error }) => {
              if (error) console.warn("[ML] Failed to record feed experiment events", error);
            });
        }
      } catch (e) {
        console.warn("[ML] Failed to flush interactions", e);
      }
    }

    // Aggregate watch-time per post then push as running average update
    if (watchBatch.length) {
      const grouped = new Map<string, { sum: number; count: number }>();
      for (const w of watchBatch) {
        const g = grouped.get(w.post_id) || { sum: 0, count: 0 };
        g.sum += w.dwell_ms;
        g.count += 1;
        grouped.set(w.post_id, g);
      }
      for (const [postId, g] of grouped) {
        try {
          // Fire-and-forget: SQL-side incremental average
          await supabase.rpc("ml_record_watch_time" as any, {
            p_post_id: postId,
            p_total_ms: g.sum,
            p_sample_count: g.count,
          });
        } catch {
          // Function may not exist yet – ignore
        }
      }
    }
  }, 1500);
}

function sanitizeInteraction(row: QueuedInteraction): QueuedInteraction {
  const next: QueuedInteraction = {
    user_id: row.user_id,
    post_id: row.post_id,
    signal_type: row.signal_type,
    weight: Number.isFinite(row.weight) ? Math.max(-9.99, Math.min(9.99, row.weight)) : 1,
  };

  if (typeof row.dwell_ms === "number" && Number.isFinite(row.dwell_ms)) {
    next.dwell_ms = Math.max(0, Math.min(24 * 60 * 60 * 1000, Math.round(row.dwell_ms)));
  }

  if (typeof row.scroll_depth === "number" && Number.isFinite(row.scroll_depth)) {
    next.scroll_depth = Math.max(0, Math.min(1, row.scroll_depth));
  }

  return next;
}

/**
 * Track a single ML signal for the feed learning engine.
 * Batched & non-blocking. Also feeds session re-ranking when author is known.
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

  // Live session re-ranking: tag the author for boost/penalty in the current session
  const authorId = postAuthorCache.get(postId);
  if (authorId) {
    if (POSITIVE_SIGNALS.includes(signal)) recordSessionSignal(authorId, "positive");
    else if (NEGATIVE_SIGNALS.includes(signal)) recordSessionSignal(authorId, "negative");
  }

  // Watch-time learning: push dwell to post-level aggregate
  if ((signal === "dwell_medium" || signal === "dwell_long" || signal === "watch_complete" || signal === "skip_fast") && extra?.dwell_ms) {
    watchTimeQueue.push({ post_id: postId, dwell_ms: extra.dwell_ms });
  }

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
              trackMLSignal(user.id, postId, "view", { scroll_depth: entry.intersectionRatio });
            }
          } else if (enterAtRef.current !== null) {
            const dwell = Date.now() - enterAtRef.current;
            enterAtRef.current = null;
            if (dwell >= 8000) {
              trackMLSignal(user.id, postId, "watch_complete", { dwell_ms: dwell, scroll_depth: entry.intersectionRatio });
            } else if (dwell >= 3000) {
              trackMLSignal(user.id, postId, "dwell_long", { dwell_ms: dwell, scroll_depth: entry.intersectionRatio });
            } else if (dwell >= 1200) {
              trackMLSignal(user.id, postId, "dwell_medium", { dwell_ms: dwell, scroll_depth: entry.intersectionRatio });
            } else if (dwell < 800 && viewedRef.current) {
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
        if (dwell >= 8000) trackMLSignal(user.id, postId, "watch_complete", { dwell_ms: dwell, scroll_depth: 1 });
        else if (dwell >= 3000) trackMLSignal(user.id, postId, "dwell_long", { dwell_ms: dwell, scroll_depth: 1 });
        else if (dwell >= 1200) trackMLSignal(user.id, postId, "dwell_medium", { dwell_ms: dwell, scroll_depth: 0.5 });
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
