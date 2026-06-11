import { useEffect, useRef, useState, ReactNode } from 'react';

/**
 * Defers mounting children until the placeholder enters (or nears) the viewport.
 * Drastically reduces work for off-screen feed injections (suggestions, reels, etc.).
 */
export function LazyMount({
  children,
  rootMargin = '600px',
  minHeight = 120,
  className,
}: {
  children: ReactNode;
  rootMargin?: string;
  minHeight?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (shown) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown, rootMargin]);

  return (
    <div ref={ref} className={className} style={!shown ? { minHeight } : undefined}>
      {shown ? children : null}
    </div>
  );
}
