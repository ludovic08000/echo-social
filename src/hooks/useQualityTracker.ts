import { useCallback, useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { isAnalyticsEnabled } from '@/lib/privacyPreferences';

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
  client_event_id: string;
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
let flushing = false;
let failures = 0;

async function flush() {
  flushTimer = null;
  if (flushing || queue.length === 0) return;
  flushing = true;
  let batch = queue.splice(0, 100);
  try {
    const session = await supabase.auth.getSession();
    if (session.error) throw session.error;
    batch = batch.filter(event => event.user_id === session.data.session?.user.id && isAnalyticsEnabled(event.user_id));
    if (batch.length) {
      // client_event_id is additive in the feed telemetry migration.
      const { error } = await supabase.from('quality_events').upsert(batch as never, { onConflict: 'client_event_id', ignoreDuplicates: true });
      if (error) throw error;
    }
    failures = 0;
  } catch {
    failures++;
    if (failures < 4) queue.unshift(...batch.slice(0, Math.max(0, 200 - queue.length)));
  } finally {
    flushing = false;
    if (queue.length) scheduleFlush();
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, Math.min(30000, 2000 * 2 ** failures));
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
  if (!contentId || !userId || !isAnalyticsEnabled(userId) || queue.length >= 200) return;
  queue.push({
    client_event_id: crypto.randomUUID(),
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
 * Temps d'exposition au premier plan seulement. Ni complétion vidéo, ni
 * performance iOS ne peuvent être déduites d'un temps d'affichage de carte.
 */
export function useQualityTracker(opts: {
  surface: Surface;
  contentId: string;
  authorId?: string | null;
  durationMs?: number; // pour calcul de completion
}) {
  const { user } = useAuth();
  const { surface, contentId, authorId = null } = opts;
  const enterAtRef = useRef<number | null>(null);
  const viewedRef = useRef(false);
  const inViewport = useRef(false);
  const viewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onEnter = useCallback(() => {
    inViewport.current = true;
    if (enterAtRef.current !== null || document.hidden) return;
    enterAtRef.current = performance.now();
    if (!viewedRef.current) {
      viewTimer.current = setTimeout(() => {
        if (!document.hidden && enterAtRef.current !== null) {
          viewedRef.current = true;
          trackQuality(user?.id ?? null, surface, contentId, authorId, 'view', 1);
        }
      }, 1000);
    }
  }, [user?.id, surface, contentId, authorId]);

  const onLeave = useCallback(() => {
    inViewport.current = false;
    if (viewTimer.current) clearTimeout(viewTimer.current);
    if (enterAtRef.current === null) return;
    const dwell = performance.now() - enterAtRef.current;
    enterAtRef.current = null;

    if (dwell < 1500) {
      trackQuality(user?.id ?? null, surface, contentId, authorId, 'skip_fast', dwell);
    } else {
      trackQuality(user?.id ?? null, surface, contentId, authorId, 'watch_time', Math.round(dwell));
    }

  }, [user?.id, surface, contentId, authorId]);

  const onShare = useCallback(() => {
    trackQuality(user?.id ?? null, surface, contentId, authorId, 'share', 1);
  }, [user?.id, surface, contentId, authorId]);

  const onSave = useCallback(() => {
    trackQuality(user?.id ?? null, surface, contentId, authorId, 'save', 1);
  }, [user?.id, surface, contentId, authorId]);

  useEffect(() => {
    viewedRef.current = false;
    const visibility = () => {
      const visible = inViewport.current;
      if (document.hidden) { onLeave(); inViewport.current = visible; }
      else if (visible) onEnter();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      if (enterAtRef.current !== null) onLeave();
    };
  }, [onLeave, onEnter]);

  return { onEnter, onLeave, onShare, onSave };
}

/** Trace une session de retour (à appeler 1x au mount d'un écran clé). */
export function trackReturnSession(userId: string | null) {
  if (!userId || !isAnalyticsEnabled(userId)) return;
  try {
    const key = `${RETURN_KEY}:${userId}`;
    const last = localStorage.getItem(key);
    const now = Date.now();
    if (last) {
      const gap = now - Number(last);
      // retour = nouvelle session après >30min d'absence
      if (gap > 30 * 60 * 1000) {
        trackQuality(userId, 'post', '00000000-0000-0000-0000-000000000000', null, 'return_session', gap);
      }
    }
    localStorage.setItem(key, String(now));
  } catch {}
}

// flush on hide
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') queueMicrotask(() => { void flush(); });
  });
}
