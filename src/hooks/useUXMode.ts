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

/** Reapply mode-scoped appearance settings to the DOM */
function reapplyAppearance(mode: UXMode) {
  const root = document.documentElement;
  const get = (key: string) => localStorage.getItem(`${mode}-${key}`) ?? localStorage.getItem(key);

  // Theme
  const themeMode = get('theme-mode') || 'dark';
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
      const surfaceH = isFlow ? 280 : h;
      const surfaceS = isFlow ? Math.max(s - 25, 20) : Math.max(s - 55, 8);
      const bgL = isFlow ? 18 : 15;
      const cardL = isFlow ? 22 : 19;
      const mutedL = isFlow ? 24 : 22;
      const secL = isFlow ? 26 : 24;
      const borderL = isFlow ? 30 : 27;
      const accentL = isFlow ? 32 : 28;
      const fgL = isFlow ? 96 : 95;
      const mutedFgL = isFlow ? 65 : 60;

      root.style.setProperty('--background', `${surfaceH} ${surfaceS}% ${bgL}%`);
      root.style.setProperty('--foreground', `${surfaceH} ${Math.max(surfaceS - 10, 5)}% ${fgL}%`);
      root.style.setProperty('--card', `${surfaceH} ${surfaceS}% ${cardL}%`);
      root.style.setProperty('--card-foreground', `${surfaceH} ${Math.max(surfaceS - 10, 5)}% ${fgL}%`);
      root.style.setProperty('--popover', `${surfaceH} ${surfaceS}% ${cardL}%`);
      root.style.setProperty('--popover-foreground', `${surfaceH} ${Math.max(surfaceS - 10, 5)}% ${fgL}%`);
      root.style.setProperty('--muted', `${surfaceH} ${Math.max(surfaceS - 4, 6)}% ${mutedL}%`);
      root.style.setProperty('--muted-foreground', `${surfaceH} ${Math.max(surfaceS - 6, 8)}% ${mutedFgL}%`);
      root.style.setProperty('--accent', `${isFlow ? 285 : h} ${Math.max(s - 30, 10)}% ${accentL}%`);
      root.style.setProperty('--accent-foreground', `${h} ${Math.max(s - 10, 30)}% 72%`);
      root.style.setProperty('--secondary', `${surfaceH} ${surfaceS}% ${secL}%`);
      root.style.setProperty('--secondary-foreground', `${surfaceH} ${Math.max(surfaceS - 8, 10)}% 82%`);
      root.style.setProperty('--border', `${surfaceH} ${Math.max(surfaceS - 4, 6)}% ${borderL}%`);
      root.style.setProperty('--input', `${surfaceH} ${Math.max(surfaceS - 4, 6)}% ${borderL}%`);

      if (isFlow) {
        root.style.setProperty('--flow-glow', `${h} ${s}% ${l}%`);
        root.style.setProperty('--flow-warm', `${Math.min(h + 15, 360)} ${Math.min(s + 5, 80)}% ${Math.min(l + 3, 75)}%`);
        root.style.setProperty('--premium-gradient', `linear-gradient(135deg, hsl(${h} ${s}% ${l}%) 0%, hsl(290 ${Math.max(s - 15, 40)}% ${Math.max(l - 3, 45)}%) 50%, hsl(265 ${Math.max(s - 10, 45)}% ${Math.min(l + 2, 75)}%) 100%)`);
        root.style.setProperty('--shadow-glow', `0 0 50px hsl(${h} ${s}% ${l}% / 0.35)`);
        root.style.setProperty('--shadow-gold', `0 4px 30px -4px hsl(${h} ${s}% ${l}% / 0.4)`);
      }
    } else {
      root.style.setProperty('--background', `${h} ${Math.max(s - 50, 8)}% 97%`);
      root.style.setProperty('--foreground', `${h} ${Math.max(s - 40, 15)}% 8%`);
      root.style.setProperty('--card', `${h} ${Math.max(s - 45, 6)}% 100%`);
      root.style.setProperty('--card-foreground', `${h} ${Math.max(s - 40, 15)}% 8%`);
      root.style.setProperty('--muted', `${h} ${Math.max(s - 40, 8)}% 92%`);
      root.style.setProperty('--muted-foreground', `${h} ${Math.max(s - 30, 12)}% 35%`);
      root.style.setProperty('--accent', `${h} ${Math.max(s - 25, 15)}% 92%`);
      root.style.setProperty('--accent-foreground', `${h} ${s}% 40%`);
      root.style.setProperty('--secondary', `${h} ${Math.max(s - 40, 10)}% 90%`);
      root.style.setProperty('--secondary-foreground', `${h} ${Math.max(s - 35, 10)}% 18%`);
      root.style.setProperty('--border', `${h} ${Math.max(s - 40, 10)}% 82%`);
      root.style.setProperty('--input', `${h} ${Math.max(s - 40, 10)}% 82%`);
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
  }, [mode, applyMode]);

  const setMode = useCallback((m: UXMode) => {
    localStorage.setItem('ux-mode', m);
    setModeState(m);
    // Re-apply that mode's appearance settings
    setTimeout(() => reapplyAppearance(m), 0);
  }, []);

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
