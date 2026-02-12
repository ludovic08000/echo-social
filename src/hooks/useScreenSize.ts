import { useState, useEffect, useMemo } from 'react';

export type ScreenSize = 'mobile' | 'tablet' | 'desktop';

const BREAKPOINTS = {
  tablet: 768,   // md
  desktop: 1024, // lg
} as const;

function getScreenSize(width: number): ScreenSize {
  if (width < BREAKPOINTS.tablet) return 'mobile';
  if (width < BREAKPOINTS.desktop) return 'tablet';
  return 'desktop';
}

export function useScreenSize() {
  const [screenSize, setScreenSize] = useState<ScreenSize>(() =>
    typeof window !== 'undefined' ? getScreenSize(window.innerWidth) : 'mobile'
  );
  const [width, setWidth] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : 0
  );

  useEffect(() => {
    let rafId: number;

    const handleResize = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const w = window.innerWidth;
        setWidth(w);
        setScreenSize(getScreenSize(w));
      });
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(rafId);
    };
  }, []);

  return useMemo(() => ({
    screenSize,
    width,
    isMobile: screenSize === 'mobile',
    isTablet: screenSize === 'tablet',
    isDesktop: screenSize === 'desktop',
    isMobileOrTablet: screenSize !== 'desktop',
  }), [screenSize, width]);
}
