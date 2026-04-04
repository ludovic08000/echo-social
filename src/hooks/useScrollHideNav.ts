import { useState, useEffect, useRef } from 'react';

/**
 * Returns true when the bottom nav should be hidden (user scrolling down).
 */
export function useScrollHideNav(threshold = 12) {
  const [hidden, setHidden] = useState(false);
  const lastScrollY = useRef(0);

  useEffect(() => {
    let ticking = false;

    const handleScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const currentY = window.scrollY;
        const delta = currentY - lastScrollY.current;

        if (Math.abs(delta) >= threshold) {
          if (currentY < 60) {
            setHidden(false);
          } else if (delta > 0) {
            setHidden(true);
          } else {
            setHidden(false);
          }
          lastScrollY.current = currentY;
        }
        ticking = false;
      });
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [threshold]);

  return hidden;
}
