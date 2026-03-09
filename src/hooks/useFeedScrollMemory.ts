import { useEffect } from 'react';

function isAppleMobileWebKit() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const isIPadOSDesktopUA = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return isIOS || isIPadOSDesktopUA;
}

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

    const saveScroll = () => {
      try {
        const snapshot: ScrollSnapshot = { y: window.scrollY, t: Date.now() };
        sessionStorage.setItem(storageKey, JSON.stringify(snapshot));
      } catch {
        // noop
      }
    };

    const scheduleSave = () => {
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
      } else if (isAppleMobileWebKit()) {
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
