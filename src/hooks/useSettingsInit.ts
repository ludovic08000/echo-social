import { useEffect } from 'react';
import { applyFeedCustomization } from '@/hooks/useFeedCustomization';
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
      const parts = accentHsl.split(' ');
      const h = parseInt(parts[0]);
      const s = parseInt(parts[1]);
      const l = parseInt(parts[2]);
      const isDark = root.classList.contains('dark');

      root.style.setProperty('--primary', accentHsl);
      root.style.setProperty('--primary-foreground', isDark ? `${h} ${Math.max(s - 40, 5)}% 98%` : `0 0% 100%`);
      root.style.setProperty('--ring', accentHsl);
      root.style.setProperty('--sidebar-primary', accentHsl);
      root.style.setProperty('--sidebar-ring', accentHsl);
      root.style.setProperty('--sidebar-accent', isDark ? `${h} ${Math.max(s - 40, 8)}% 18%` : `${h} ${Math.max(s - 30, 10)}% 94%`);
      root.style.setProperty('--sidebar-accent-foreground', isDark ? `${h} ${Math.max(s - 15, 20)}% 80%` : `${h} ${s}% 35%`);
      root.style.setProperty('--shadow-glow', `0 0 40px hsl(${accentHsl} / 0.25)`);
      root.style.setProperty('--shadow-gold', `0 4px 25px -4px hsl(${accentHsl} / 0.3)`);
      root.style.setProperty('--premium-gradient', `linear-gradient(135deg, hsl(${h} ${s}% ${l}%) 0%, hsl(${h + 15} ${Math.max(s - 10, 30)}% ${l + 5}%) 50%, hsl(${h + 30} ${s}% ${l + 8}%) 100%)`);

      if (isDark) {
        root.style.setProperty('--background', `${h} ${Math.max(s - 55, 8)}% 10%`);
        root.style.setProperty('--foreground', `${h} ${Math.max(s - 50, 5)}% 92%`);
        root.style.setProperty('--card', `${h} ${Math.max(s - 52, 8)}% 12%`);
        root.style.setProperty('--card-foreground', `${h} ${Math.max(s - 50, 5)}% 92%`);
        root.style.setProperty('--popover', `${h} ${Math.max(s - 52, 8)}% 12%`);
        root.style.setProperty('--popover-foreground', `${h} ${Math.max(s - 50, 5)}% 92%`);
        root.style.setProperty('--muted', `${h} ${Math.max(s - 50, 6)}% 16%`);
        root.style.setProperty('--muted-foreground', `${h} ${Math.max(s - 45, 8)}% 55%`);
        root.style.setProperty('--accent', `${h} ${Math.max(s - 30, 10)}% 20%`);
        root.style.setProperty('--accent-foreground', `${h} ${Math.max(s - 10, 30)}% 72%`);
        root.style.setProperty('--secondary', `${h} ${Math.max(s - 48, 8)}% 15%`);
        root.style.setProperty('--secondary-foreground', `${h} ${Math.max(s - 40, 10)}% 82%`);
        root.style.setProperty('--border', `${h} ${Math.max(s - 50, 6)}% 18%`);
        root.style.setProperty('--input', `${h} ${Math.max(s - 50, 6)}% 18%`);
      } else {
        root.style.setProperty('--background', `${h} ${Math.max(s - 45, 10)}% 98%`);
        root.style.setProperty('--foreground', `${h} ${Math.max(s - 40, 10)}% 12%`);
        root.style.setProperty('--card', `${h} ${Math.max(s - 40, 8)}% 99%`);
        root.style.setProperty('--card-foreground', `${h} ${Math.max(s - 40, 10)}% 12%`);
        root.style.setProperty('--popover', `${h} ${Math.max(s - 40, 8)}% 99%`);
        root.style.setProperty('--popover-foreground', `${h} ${Math.max(s - 40, 10)}% 12%`);
        root.style.setProperty('--muted', `${h} ${Math.max(s - 40, 8)}% 94%`);
        root.style.setProperty('--muted-foreground', `${h} ${Math.max(s - 35, 10)}% 42%`);
        root.style.setProperty('--accent', `${h} ${Math.max(s - 25, 15)}% 94%`);
        root.style.setProperty('--accent-foreground', `${h} ${s}% 40%`);
        root.style.setProperty('--secondary', `${h} ${Math.max(s - 40, 10)}% 93%`);
        root.style.setProperty('--secondary-foreground', `${h} ${Math.max(s - 35, 10)}% 25%`);
        root.style.setProperty('--border', `${h} ${Math.max(s - 45, 8)}% 88%`);
        root.style.setProperty('--input', `${h} ${Math.max(s - 45, 8)}% 88%`);
      }
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

    // ── Feed customization ──
    try {
      const feedCustom = localStorage.getItem('feed-customization');
      if (feedCustom) {
        applyFeedCustomization(JSON.parse(feedCustom));
      }
    } catch {
      // ignore
    }
  }, []);
}
