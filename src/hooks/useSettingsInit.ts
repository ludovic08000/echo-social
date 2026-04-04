import { useEffect } from 'react';
import { applyFeedCustomization } from '@/hooks/useFeedCustomization';
import { reapplyAppearance } from '@/hooks/useUXMode';
import type { UXMode } from '@/hooks/useUXMode';

/** Get mode-scoped key, with fallback to global */
function modeGet(mode: UXMode, key: string): string | null {
  return localStorage.getItem(`${mode}-${key}`) ?? localStorage.getItem(key);
}

/**
 * Reads all persisted settings from localStorage on app startup
 * and applies them to the DOM so they take effect immediately.
 */
export function useSettingsInit(currentMode?: UXMode) {
  const mode: UXMode = currentMode || (localStorage.getItem('ux-mode') as UXMode) || 'focus';
  useEffect(() => {
    const root = document.documentElement;

    // ── Apply theme + accent + surfaces via the single source of truth ──
    reapplyAppearance(mode);

    // ── Accessibility prefs ──
    try {
      const a11y = localStorage.getItem('accessibility-prefs');
      if (a11y) {
        const prefs = JSON.parse(a11y);
        root.classList.toggle('reduced-motion', !!prefs.reducedMotion);
        root.classList.toggle('high-contrast', !!prefs.highContrast);
        root.classList.toggle('large-targets', !!prefs.largeClickTargets);
        if (prefs.lineSpacing) {
          root.style.setProperty('--line-height-factor', String(prefs.lineSpacing));
        }
      }
    } catch {
      // ignore parse errors
    }

    // ── Feed customization ──
    try {
      const feedCustom = modeGet(mode, 'feed-customization');
      if (feedCustom) {
        applyFeedCustomization(JSON.parse(feedCustom));
      }
    } catch {
      // ignore
    }
  }, [mode]);
}
