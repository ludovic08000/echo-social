import { useEffect } from 'react';
import { isAppleMobileWebKit } from '@/lib/platform';

interface ScrollSnapshot {
  y: number;
  t: number;
}

const MAX_AGE_MS = 30 * 60 * 1000;

export function useFeedScrollMemory(storageKey = 'feed-scroll-memory') {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    let rafId: number | null = null;

    const readSnapshot = (): ScrollSnapshot | null => {
      try {
        const raw = sessionStorage.getItem(storageKey);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<ScrollSnapshot>;
        if (typeof parsed?.y !== 'number' || typeof parsed?.t !== 'number') return null;
        if (Date.now() - parsed.t > MAX_AGE_MS) return null;
        return { y: Math.max(0, parsed.y), t: parsed.t };
      } catch {
        return null;
      }
    };

    // Throttle scroll saves to max once every 300ms to reduce CPU pressure
    let lastSaveTime = 0;
    const THROTTLE_MS = 300;

    const saveScroll = () => {
      try {
        const snapshot: ScrollSnapshot = { y: window.scrollY, t: Date.now() };
        sessionStorage.setItem(storageKey, JSON.stringify(snapshot));
        lastSaveTime = snapshot.t;
      } catch {
        // noop
      }
    };

    const scheduleSave = () => {
      const now = Date.now();
      if (now - lastSaveTime < THROTTLE_MS) return;
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        saveScroll();
        rafId = null;
      });
    };

    const restoreScroll = () => {
      const snapshot = readSnapshot();
      if (!snapshot) return;
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: snapshot.y, behavior: 'auto' });
      });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        saveScroll();
      if (isAppleMobileWebKit()) {
        restoreScroll();
      }
    };

    const handlePageShow = () => {
      if (isAppleMobileWebKit()) restoreScroll();
    };

    // Initial restore on mount (after route/component remount)
    restoreScroll();

    window.addEventListener('scroll', scheduleSave, { passive: true });
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', saveScroll);
    window.addEventListener('beforeunload', saveScroll);
    window.addEventListener('pageshow', handlePageShow);

    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      window.removeEventListener('scroll', scheduleSave);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', saveScroll);
      window.removeEventListener('beforeunload', saveScroll);
      window.removeEventListener('pageshow', handlePageShow);
      saveScroll();
    };
  }, [storageKey]);
}
