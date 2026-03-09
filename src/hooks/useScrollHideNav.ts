import { useState, useEffect, useRef } from 'react';

function isAppleMobileWebKit() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const isIPadOSDesktopUA = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return isIOS || isIPadOSDesktopUA;
}

/**
 * Returns true when the bottom nav should be hidden (user scrolling down).
 * On iOS/iPadOS Safari we keep nav stable to avoid bounce/jitter.
 */
export function useScrollHideNav(threshold = 18) {
  const [hidden, setHidden] = useState(false);
  const lastScrollY = useRef(0);

  useEffect(() => {
    if (isAppleMobileWebKit()) {
      setHidden(false);
      return;
    }

    let ticking = false;

    const handleScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const currentY = window.scrollY;
        const last = lastScrollY.current;
        const delta = currentY - last;

        if (Math.abs(delta) < threshold) {
          ticking = false;
          return;
        }

        if (currentY < 80) {
          setHidden(false);
        } else if (delta > threshold && currentY > 140) {
          setHidden((prev) => (prev ? prev : true));
        } else if (delta < -threshold) {
          setHidden((prev) => (prev ? false : prev));
        }

        lastScrollY.current = currentY;
        ticking = false;
      });
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [threshold]);

  return hidden;
}
