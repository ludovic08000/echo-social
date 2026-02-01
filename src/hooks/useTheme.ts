import { useEffect } from 'react';

type Theme = 'dark';

export function useTheme() {
  const theme: Theme = 'dark';

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light');
    root.classList.add('dark');
  }, []);

  return { theme, setTheme: () => {}, toggleTheme: () => {} };
}
