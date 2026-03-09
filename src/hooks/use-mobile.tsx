import * as React from "react";

const MOBILE_BREAKPOINT = 768;

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean>(
    typeof window !== "undefined" ? window.innerWidth < MOBILE_BREAKPOINT : false
  );

  React.useEffect(() => {
    const update = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);

    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);

    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", update);
    } else {
      mql.addListener(update);
    }

    window.addEventListener("orientationchange", update, { passive: true });
    update();

    return () => {
      if (typeof mql.removeEventListener === "function") {
        mql.removeEventListener("change", update);
      } else {
        mql.removeListener(update);
      }
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  return isMobile;
}

