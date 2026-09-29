import { useState, useEffect, useCallback, createContext, useContext } from 'react';

export type UXMode = 'focus' | 'flow';

interface UXModeContextType {
  mode: UXMode;
  setMode: (m: UXMode) => void;
  toggleMode: () => void;
  isFlow: boolean;
}

export const UXModeContext = createContext<UXModeContextType>({
  mode: 'focus',
  setMode: () => {},
  toggleMode: () => {},
  isFlow: false,
});

export function useUXMode() {
  return useContext(UXModeContext);
}

export const APPEARANCE_CHANGED_EVENT = 'forsure:appearance-changed';

export function getAppearanceSetting(mode: UXMode, key: string): string | null {
  return localStorage.getItem(`${mode}-${key}`) ?? localStorage.getItem(key);
}

export function areAppearanceAnimationsDisabled(mode: UXMode): boolean {
  return getAppearanceSetting(mode, 'animations-disabled') === 'true';
}

export function notifyAppearanceChanged(mode: UXMode) {
  window.dispatchEvent(new CustomEvent(APPEARANCE_CHANGED_EVENT, { detail: { mode } }));
}

/** Reapply mode-scoped appearance settings to the DOM */
export function reapplyAppearance(mode: UXMode) {
  const root = document.documentElement;
  const get = (key: string) => getAppearanceSetting(mode, key);

  // Theme
  const savedThemeMode = get('theme-mode') || 'dark';
  const dynamicTheme = get('dynamic-theme') === 'true';
  const hour = new Date().getHours();
  const themeMode = dynamicTheme ? (hour >= 6 && hour < 18 ? 'light' : 'dark') : savedThemeMode;
  if (themeMode === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.classList.toggle('dark', prefersDark);
    root.classList.toggle('light', !prefersDark);
  } else {
    root.classList.toggle('dark', themeMode === 'dark');
    root.classList.toggle('light', themeMode === 'light');
  }

  // Accent color
  const accentColors: Record<string, string> = {
    bleu: '220 70% 50%', emerald: '160 60% 45%', violet: '270 60% 55%',
    rose: '340 65% 55%', amber: '35 80% 50%', coral: '15 75% 55%',
  };
  const accentId = get('accent-color') || 'bleu';
  const accentHsl = accentColors[accentId];
  if (accentHsl) {
    const [h, s, l] = accentHsl.split(' ').map(v => parseInt(v));
    const isDark = root.classList.contains('dark');
    root.style.setProperty('--primary', accentHsl);
    root.style.setProperty('--primary-foreground', isDark ? `${h} ${Math.max(s - 40, 5)}% 98%` : `0 0% 100%`);
    root.style.setProperty('--ring', accentHsl);
    root.style.setProperty('--sidebar-primary', accentHsl);
    root.style.setProperty('--sidebar-ring', accentHsl);
    root.style.setProperty('--shadow-glow', `0 0 40px hsl(${accentHsl} / 0.25)`);
    root.style.setProperty('--shadow-gold', `0 4px 25px -4px hsl(${accentHsl} / 0.3)`);
    root.style.setProperty('--premium-gradient', `linear-gradient(135deg, hsl(${h} ${s}% ${l}%) 0%, hsl(${h + 15} ${Math.max(s - 10, 30)}% ${l + 5}%) 50%, hsl(${h + 30} ${s}% ${l + 8}%) 100%)`);
    const isFlow = root.classList.contains('ux-flow');

    if (isDark) {
      const surfaceH = isFlow ? 332 : h;
      const surfaceS = isFlow ? 28 : Math.max(s - 55, 8);
      const bgL = isFlow ? 10 : 15;
      const cardL = isFlow ? 14 : 19;
      const mutedL = isFlow ? 16 : 22;
      const secL = isFlow ? 18 : 24;
      const borderL = isFlow ? 24 : 27;
      const accentL = isFlow ? 22 : 28;
      const fgL = isFlow ? 96 : 95;
      const mutedFgL = isFlow ? 60 : 60;

      root.style.setProperty('--background', `${isFlow ? 330 : surfaceH} ${isFlow ? 30 : surfaceS}% ${bgL}%`);
      root.style.setProperty('--foreground', `${isFlow ? 335 : surfaceH} ${Math.max(surfaceS - 10, 5)}% ${fgL}%`);
      root.style.setProperty('--card', `${surfaceH} ${surfaceS}% ${cardL}%`);
      root.style.setProperty('--card-foreground', `${isFlow ? 335 : surfaceH} ${Math.max(surfaceS - 10, 5)}% ${fgL}%`);
      root.style.setProperty('--popover', `${surfaceH} ${surfaceS}% ${cardL}%`);
      root.style.setProperty('--popover-foreground', `${isFlow ? 335 : surfaceH} ${Math.max(surfaceS - 10, 5)}% ${fgL}%`);
      root.style.setProperty('--muted', `${surfaceH} ${Math.max(surfaceS - 4, 6)}% ${mutedL}%`);
      root.style.setProperty('--muted-foreground', `${isFlow ? 335 : surfaceH} ${Math.max(surfaceS - 6, 8)}% ${mutedFgL}%`);
      root.style.setProperty('--accent', `${isFlow ? 338 : h} ${Math.max(s - 30, 10)}% ${accentL}%`);
      root.style.setProperty('--accent-foreground', `${isFlow ? 340 : h} ${Math.max(s - 10, 30)}% 72%`);
      root.style.setProperty('--secondary', `${isFlow ? 335 : surfaceH} ${surfaceS}% ${secL}%`);
      root.style.setProperty('--secondary-foreground', `${surfaceH} ${Math.max(surfaceS - 8, 10)}% 82%`);
      root.style.setProperty('--border', `${isFlow ? 338 : surfaceH} ${Math.max(surfaceS - 4, 6)}% ${borderL}%`);
      root.style.setProperty('--input', `${surfaceH} ${Math.max(surfaceS - 4, 6)}% ${borderL}%`);

      if (isFlow) {
        const glowH = h;
        const glowS = Math.max(s, 65);
        const glowL = Math.max(l, 58);
        const middleH = (h + 20) % 360;
        const endH = (h + 40) % 360;
        root.style.setProperty('--primary', `${glowH} ${glowS}% ${glowL}%`);
        root.style.setProperty('--primary-foreground', '0 0% 100%');
        root.style.setProperty('--ring', `${glowH} ${glowS}% ${glowL}%`);
        root.style.setProperty('--flow-glow', `${glowH} ${glowS}% ${glowL}%`);
        root.style.setProperty('--flow-warm', `${(h + 10) % 360} ${Math.max(s, 60)}% ${Math.min(glowL + 4, 72)}%`);
        root.style.setProperty('--premium-gradient', `linear-gradient(135deg, hsl(${glowH} ${glowS}% ${glowL}%) 0%, hsl(${middleH} ${Math.max(glowS - 12, 45)}% ${Math.max(glowL - 5, 45)}%) 50%, hsl(${endH} ${Math.max(glowS - 22, 40)}% ${Math.max(glowL - 3, 45)}%) 100%)`);
        root.style.setProperty('--shadow-glow', `0 0 60px hsl(${glowH} ${glowS}% ${glowL}% / 0.35), 0 0 120px hsl(${middleH} ${Math.max(glowS - 15, 45)}% ${Math.max(glowL - 7, 45)}% / 0.15)`);
        root.style.setProperty('--shadow-gold', `0 4px 35px -4px hsl(${glowH} ${glowS}% ${glowL}% / 0.42)`);
      }
    } else {
      const flowLight = isFlow;
      const bgH = flowLight ? 330 : h;
      const bgS = flowLight ? 50 : Math.max(s - 50, 8);
      root.style.setProperty('--background', `${bgH} ${bgS}% ${flowLight ? 96 : 97}%`);
      root.style.setProperty('--foreground', `${flowLight ? 320 : h} ${Math.max(s - 40, 15)}% ${flowLight ? 12 : 8}%`);
      root.style.setProperty('--card', `${flowLight ? 335 : h} ${flowLight ? 45 : Math.max(s - 45, 6)}% ${flowLight ? 99 : 100}%`);
      root.style.setProperty('--card-foreground', `${flowLight ? 320 : h} ${Math.max(s - 40, 15)}% ${flowLight ? 12 : 8}%`);
      root.style.setProperty('--muted', `${flowLight ? 330 : h} ${flowLight ? 35 : Math.max(s - 40, 8)}% ${flowLight ? 90 : 92}%`);
      root.style.setProperty('--muted-foreground', `${flowLight ? 320 : h} ${flowLight ? 22 : Math.max(s - 30, 12)}% ${flowLight ? 42 : 35}%`);
      root.style.setProperty('--accent', `${flowLight ? 310 : h} ${flowLight ? 50 : Math.max(s - 25, 15)}% 92%`);
      root.style.setProperty('--accent-foreground', `${flowLight ? 335 : h} ${flowLight ? 70 : s}% 40%`);
      root.style.setProperty('--secondary', `${flowLight ? 335 : h} ${flowLight ? 45 : Math.max(s - 40, 10)}% ${flowLight ? 92 : 90}%`);
      root.style.setProperty('--secondary-foreground', `${flowLight ? 320 : h} ${Math.max(s - 35, 10)}% 18%`);
      root.style.setProperty('--border', `${flowLight ? 335 : h} ${flowLight ? 40 : Math.max(s - 40, 10)}% ${flowLight ? 84 : 82}%`);
      root.style.setProperty('--input', `${flowLight ? 330 : h} ${flowLight ? 35 : Math.max(s - 40, 10)}% ${flowLight ? 92 : 82}%`);

      if (flowLight) {
        const glowH = h;
        const glowS = Math.max(s, 65);
        const glowL = Math.max(l, 55);
        const middleH = (h + 20) % 360;
        const endH = (h + 40) % 360;
        root.style.setProperty('--primary', `${glowH} ${glowS}% ${glowL}%`);
        root.style.setProperty('--primary-foreground', '0 0% 100%');
        root.style.setProperty('--ring', `${glowH} ${glowS}% ${glowL}%`);
        root.style.setProperty('--flow-glow', `${glowH} ${glowS}% ${glowL}%`);
        root.style.setProperty('--flow-warm', `${(h + 10) % 360} ${Math.max(s, 60)}% ${Math.min(glowL + 6, 72)}%`);
        root.style.setProperty('--premium-gradient', `linear-gradient(135deg, hsl(${glowH} ${glowS}% ${glowL}%) 0%, hsl(${middleH} ${Math.max(glowS - 12, 45)}% ${Math.max(glowL - 3, 45)}%) 50%, hsl(${endH} ${Math.max(glowS - 20, 40)}% ${Math.min(glowL + 2, 68)}%) 100%)`);
        root.style.setProperty('--shadow-glow', `0 0 50px hsl(${glowH} ${glowS}% ${glowL}% / 0.25), 0 0 100px hsl(${middleH} ${Math.max(glowS - 15, 45)}% ${Math.max(glowL - 5, 45)}% / 0.1)`);
        root.style.setProperty('--shadow-gold', `0 4px 28px -4px hsl(${glowH} ${glowS}% ${glowL}% / 0.3)`);
      }
    }
  }

  // Font size
  const fontSize = get('font-size');
  if (fontSize) root.style.fontSize = `${fontSize}px`;
  else root.style.fontSize = '';

  // Compact & animations
  root.classList.toggle('compact-mode', get('compact-mode') === 'true');
  root.classList.toggle('no-animations', get('animations-disabled') === 'true');
}

export function useUXModeProvider() {
  const [mode, setModeState] = useState<UXMode>(() => {
    return (localStorage.getItem('ux-mode') as UXMode) || 'focus';
  });

  const applyMode = useCallback((m: UXMode) => {
    const root = document.documentElement;
    if (m === 'flow') {
      root.classList.add('ux-flow');
      root.classList.remove('ux-focus');
    } else {
      root.classList.add('ux-focus');
      root.classList.remove('ux-flow');
    }
  }, []);

  useEffect(() => {
    applyMode(mode);
    reapplyAppearance(mode);
    notifyAppearanceChanged(mode);
  }, [mode, applyMode]);

  const setMode = useCallback((m: UXMode) => {
    localStorage.setItem('ux-mode', m);
    setModeState(m);
    // Apply class immediately so reapplyAppearance sees the correct state
    applyMode(m);
    reapplyAppearance(m);
    notifyAppearanceChanged(m);
  }, [applyMode]);

  const toggleMode = useCallback(() => {
    setMode(mode === 'focus' ? 'flow' : 'focus');
  }, [mode, setMode]);

  return {
    mode,
    setMode,
    toggleMode,
    isFlow: mode === 'flow',
  };
}
