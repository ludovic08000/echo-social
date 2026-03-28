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
