import { useState, useEffect, useCallback } from 'react';

/**
 * Returns true when the bottom nav should be hidden (user scrolling down).
 * Shows again when scrolling up or near the top.
 */
export function useScrollHideNav(threshold = 10) {
  const [hidden, setHidden] = useState(false);
  const [lastScrollY, setLastScrollY] = useState(0);

  const handleScroll = useCallback(() => {
    const currentY = window.scrollY;
    if (currentY < 60) {
      // Near top: always show
      setHidden(false);
    } else if (currentY - lastScrollY > threshold) {
      // Scrolling down
      setHidden(true);
    } else if (lastScrollY - currentY > threshold) {
      // Scrolling up
      setHidden(false);
    }
    setLastScrollY(currentY);
  }, [lastScrollY, threshold]);

  useEffect(() => {
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  return hidden;
}
