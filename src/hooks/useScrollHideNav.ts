import { useState, useEffect, useRef } from 'react';

/**
 * Returns true when the bottom nav should be hidden (user scrolling down).
 * Shows again when scrolling up or near the top.
 * Uses a ref for lastScrollY to avoid re-creating the listener on every scroll.
 */
export function useScrollHideNav(threshold = 10) {
  const [hidden, setHidden] = useState(false);
  const lastScrollY = useRef(0);

  useEffect(() => {
    let ticking = false;

    const handleScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const currentY = window.scrollY;
        const last = lastScrollY.current;

        if (currentY < 60) {
          setHidden(false);
        } else if (currentY - last > threshold) {
          setHidden(true);
        } else if (last - currentY > threshold) {
          setHidden(false);
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
