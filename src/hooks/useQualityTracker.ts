import { useCallback, useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

type Surface = 'video' | 'post' | 'live';
type EventType =
  | 'view'
  | 'watch_time'
  | 'completion'
  | 'skip_fast'
  | 'rewatch'
  | 'share'
  | 'save'
  | 'return_session'
  | 'ios_perf';

interface QEvent {
  user_id: string | null;
  session_id: string;
  surface: Surface;
  content_id: string;
  author_id: string | null;
  event_type: EventType;
  value: number;
  metadata: Record<string, unknown>;
  is_ios: boolean;
}

const SESSION_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const IS_IOS = /iPad|iPhone|iPod/.test(typeof navigator !== 'undefined' ? navigator.userAgent : '');
const RETURN_KEY = 'forsure:quality:last_session_at';

const queue: QEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function flush() {
  flushTimer = null;
  if (queue.length === 0) return;
  const batch = queue.splice(0, queue.length);
  try {
    await supabase.from('quality_events' as any).insert(batch as any);
  } catch {
    // silent — telemetry non-critique
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 2000);
}

export function trackQuality(
  userId: string | null,
  surface: Surface,
  contentId: string,
  authorId: string | null,
  eventType: EventType,
  value: number = 1,
  metadata: Record<string, unknown> = {}
) {
  if (!contentId) return;
  queue.push({
    user_id: userId,
    session_id: SESSION_ID,
    surface,
    content_id: contentId,
    author_id: authorId,
    event_type: eventType,
    value: Number.isFinite(value) ? value : 0,
    metadata,
    is_ios: IS_IOS,
  });
  if (queue.length >= 25) flush();
  else scheduleFlush();
}

/**
 * Tracker complet pour une carte vidéo/post/live.
 * - view: dès qu'au moins 1s d'affichage
 * - watch_time + completion: à la sortie de la vue
 * - skip_fast: dwell < 1500ms après view
 * - rewatch: replay détecté
 */
export function useQualityTracker(opts: {
  surface: Surface;
  contentId: string;
  authorId?: string | null;
  durationMs?: number; // pour calcul de completion
}) {
  const { user } = useAuth();
  const { surface, contentId, authorId = null, durationMs } = opts;
  const enterAtRef = useRef<number | null>(null);
  const viewedRef = useRef(false);
  const watchedMsRef = useRef(0);
  const replayCountRef = useRef(0);

  const onEnter = useCallback(() => {
    if (enterAtRef.current !== null) return;
    enterAtRef.current = performance.now();
    if (!viewedRef.current) {
      viewedRef.current = true;
      trackQuality(user?.id ?? null, surface, contentId, authorId, 'view', 1);
    } else {
      replayCountRef.current += 1;
      trackQuality(user?.id ?? null, surface, contentId, authorId, 'rewatch', replayCountRef.current);
    }
  }, [user?.id, surface, contentId, authorId]);

  const onLeave = useCallback(() => {
    if (enterAtRef.current === null) return;
    const dwell = performance.now() - enterAtRef.current;
    enterAtRef.current = null;
    watchedMsRef.current += dwell;

    if (dwell < 1500) {
      trackQuality(user?.id ?? null, surface, contentId, authorId, 'skip_fast', dwell);
    } else {
      trackQuality(user?.id ?? null, surface, contentId, authorId, 'watch_time', Math.round(dwell));
      if (durationMs && durationMs > 0) {
        const pct = Math.min(100, Math.round((watchedMsRef.current / durationMs) * 100));
        trackQuality(user?.id ?? null, surface, contentId, authorId, 'completion', pct);
      }
    }

    // iOS perf: mesure du frame budget
    if (IS_IOS) {
      const perf = Math.round(dwell);
      trackQuality(user?.id ?? null, surface, contentId, authorId, 'ios_perf', perf, {
        memory: (performance as any).memory?.usedJSHeapSize ?? null,
      });
    }
  }, [user?.id, surface, contentId, authorId, durationMs]);

  const onShare = useCallback(() => {
    trackQuality(user?.id ?? null, surface, contentId, authorId, 'share', 1);
  }, [user?.id, surface, contentId, authorId]);

  const onSave = useCallback(() => {
    trackQuality(user?.id ?? null, surface, contentId, authorId, 'save', 1);
  }, [user?.id, surface, contentId, authorId]);

  useEffect(() => {
    return () => {
      if (enterAtRef.current !== null) onLeave();
    };
  }, [onLeave]);

  return { onEnter, onLeave, onShare, onSave };
}

/** Trace une session de retour (à appeler 1x au mount d'un écran clé). */
export function trackReturnSession(userId: string | null) {
  try {
    const last = localStorage.getItem(RETURN_KEY);
    const now = Date.now();
    if (last) {
      const gap = now - Number(last);
      // retour = nouvelle session après >30min d'absence
      if (gap > 30 * 60 * 1000) {
        trackQuality(userId, 'post', '00000000-0000-0000-0000-000000000000', null, 'return_session', gap);
      }
    }
    localStorage.setItem(RETURN_KEY, String(now));
  } catch {}
}

// flush on hide
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}
