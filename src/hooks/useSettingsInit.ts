import { useEffect, useState } from 'react';
import { applyFeedCustomization } from '@/hooks/useFeedCustomization';
import {
  APPEARANCE_CHANGED_EVENT,
  areAppearanceAnimationsDisabled,
  getAppearanceSetting,
  reapplyAppearance,
} from '@/hooks/useUXMode';
import type { UXMode } from '@/hooks/useUXMode';
import {
  ACCESSIBILITY_CHANGED_EVENT,
  applyAccessibilityPreferences,
  readAccessibilityPreferences,
} from '@/lib/accessibilityPreferences';

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
  const [animationsDisabled, setAnimationsDisabled] = useState(() =>
    areAppearanceAnimationsDisabled(mode) || readAccessibilityPreferences().reducedMotion
  );

  useEffect(() => {
    const applyRuntimeAppearance = () => {
      reapplyAppearance(mode);
      setAnimationsDisabled(
        areAppearanceAnimationsDisabled(mode) || readAccessibilityPreferences().reducedMotion
      );
    };

    // ── Apply theme + accent + surfaces via the single source of truth ──
    applyRuntimeAppearance();

    // ── Accessibility prefs ──
    applyAccessibilityPreferences();

    // ── Feed customization ──
    try {
      const feedCustom = modeGet(mode, 'feed-customization');
      if (feedCustom) {
        applyFeedCustomization(JSON.parse(feedCustom));
      }
    } catch {
      // ignore
    }

    // Keep system/dynamic themes and animation preferences active even when
    // the Appearance settings panel is not mounted.
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onAppearanceChanged = (event: Event) => {
      const changedMode = (event as CustomEvent<{ mode?: UXMode }>).detail?.mode;
      if (!changedMode || changedMode === mode) applyRuntimeAppearance();
    };
    const onAccessibilityChanged = () => {
      applyAccessibilityPreferences();
      applyRuntimeAppearance();
    };
    const onStorage = (event: StorageEvent) => {
      const legacyKeys = [
        'theme-mode',
        'accent-color',
        'font-size',
        'compact-mode',
        'animations-disabled',
        'dynamic-theme',
      ];
      if (!event.key || event.key.startsWith(`${mode}-`) || legacyKeys.includes(event.key)) {
        applyRuntimeAppearance();
      }
    };

    if (media.addEventListener) {
      media.addEventListener('change', applyRuntimeAppearance);
    } else {
      media.addListener(applyRuntimeAppearance);
    }
    window.addEventListener(APPEARANCE_CHANGED_EVENT, onAppearanceChanged);
    window.addEventListener(ACCESSIBILITY_CHANGED_EVENT, onAccessibilityChanged);
    window.addEventListener('storage', onStorage);

    const dynamicTimer = window.setInterval(() => {
      if (getAppearanceSetting(mode, 'dynamic-theme') === 'true') {
        applyRuntimeAppearance();
      }
    }, 60_000);

    return () => {
      if (media.removeEventListener) {
        media.removeEventListener('change', applyRuntimeAppearance);
      } else {
        media.removeListener(applyRuntimeAppearance);
      }
      window.removeEventListener(APPEARANCE_CHANGED_EVENT, onAppearanceChanged);
      window.removeEventListener(ACCESSIBILITY_CHANGED_EVENT, onAccessibilityChanged);
      window.removeEventListener('storage', onStorage);
      window.clearInterval(dynamicTimer);
    };
  }, [mode]);

  return { animationsDisabled };
}
