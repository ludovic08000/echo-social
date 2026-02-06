import { useEffect } from 'react';

/**
 * Reads all persisted settings from localStorage on app startup
 * and applies them to the DOM so they take effect immediately.
 */
export function useSettingsInit() {
  useEffect(() => {
    const root = document.documentElement;

    // ── Theme mode ──
    const themeMode = localStorage.getItem('theme-mode') || 'dark';
    if (themeMode === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.classList.toggle('dark', prefersDark);
      root.classList.toggle('light', !prefersDark);
    } else {
      root.classList.toggle('dark', themeMode === 'dark');
      root.classList.toggle('light', themeMode === 'light');
    }

    // ── Accent color ──
    const accentColors: Record<string, string> = {
      bleu: '220 70% 50%',
      emerald: '160 60% 45%',
      violet: '270 60% 55%',
      rose: '340 65% 55%',
      amber: '35 80% 50%',
      coral: '15 75% 55%',
    };
    const accentId = localStorage.getItem('accent-color') || 'bleu';
    const accentHsl = accentColors[accentId];
    if (accentHsl) {
      root.style.setProperty('--primary', accentHsl);
      root.style.setProperty('--ring', accentHsl);
    }

    // ── Font size ──
    const fontSize = localStorage.getItem('font-size');
    if (fontSize) {
      root.style.fontSize = `${fontSize}px`;
    }

    // ── Compact mode ──
    const compact = localStorage.getItem('compact-mode') === 'true';
    root.classList.toggle('compact-mode', compact);

    // ── Animations ──
    const animDisabled = localStorage.getItem('animations-disabled') === 'true';
    root.classList.toggle('no-animations', animDisabled);

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
  }, []);
}
