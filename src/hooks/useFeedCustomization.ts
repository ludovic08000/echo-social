import { useState, useEffect, useMemo } from 'react';

export interface FeedCustomization {
  fontFamily: string;
  textColor: string;
  bgColor: string;
}

const DEFAULTS: FeedCustomization = {
  fontFamily: 'system',
  textColor: '',
  bgColor: '',
};

const STORAGE_KEY = 'feed-customization';

export const FONT_OPTIONS = [
  { id: 'system', label: 'Système (défaut)', css: 'inherit' },
  { id: 'inter', label: 'Inter', css: '"Inter", sans-serif' },
  { id: 'georgia', label: 'Georgia', css: '"Georgia", serif' },
  { id: 'comic', label: 'Comic Neue', css: '"Comic Neue", cursive' },
  { id: 'mono', label: 'Monospace', css: '"JetBrains Mono", monospace' },
  { id: 'poppins', label: 'Poppins', css: '"Poppins", sans-serif' },
  { id: 'playfair', label: 'Playfair Display', css: '"Playfair Display", serif' },
];

export const TEXT_COLOR_OPTIONS = [
  { id: '', label: 'Par défaut', preview: 'bg-foreground' },
  { id: '#FFFFFF', label: 'Blanc', preview: 'bg-white' },
  { id: '#1a1a2e', label: 'Nuit', preview: 'bg-[#1a1a2e]' },
  { id: '#e0c3fc', label: 'Lavande', preview: 'bg-[#e0c3fc]' },
  { id: '#ffd6e0', label: 'Rose doux', preview: 'bg-[#ffd6e0]' },
  { id: '#c9f0ff', label: 'Ciel', preview: 'bg-[#c9f0ff]' },
  { id: '#d4fc79', label: 'Lime', preview: 'bg-[#d4fc79]' },
  { id: '#ffeaa7', label: 'Doré', preview: 'bg-[#ffeaa7]' },
];

export const BG_COLOR_OPTIONS = [
  { id: '', label: 'Par défaut', preview: 'bg-background' },
  { id: '#0d0d1a', label: 'Nuit profonde', preview: 'bg-[#0d0d1a]' },
  { id: '#1a1025', label: 'Violet nuit', preview: 'bg-[#1a1025]' },
  { id: '#f8f0ff', label: 'Lavande clair', preview: 'bg-[#f8f0ff]' },
  { id: '#fff0f5', label: 'Rose pâle', preview: 'bg-[#fff0f5]' },
  { id: '#f0f9ff', label: 'Bleu glacier', preview: 'bg-[#f0f9ff]' },
  { id: '#fefce8', label: 'Crème', preview: 'bg-[#fefce8]' },
  { id: '#f5f5f4', label: 'Pierre', preview: 'bg-[#f5f5f4]' },
  { id: '#1c1917', label: 'Charbon', preview: 'bg-[#1c1917]' },
];

function load(): FeedCustomization {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

/** Apply feed customization CSS variables to :root */
export function applyFeedCustomization(c: FeedCustomization) {
  const root = document.documentElement;
  const font = FONT_OPTIONS.find(f => f.id === c.fontFamily);
  root.style.setProperty('--feed-font', font?.css || 'inherit');
  root.style.setProperty('--feed-text-color', c.textColor || '');
  root.style.setProperty('--feed-bg-color', c.bgColor || '');
}

export function useFeedCustomization() {
  const [prefs, setPrefs] = useState<FeedCustomization>(load);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    applyFeedCustomization(prefs);
  }, [prefs]);

  const update = (patch: Partial<FeedCustomization>) =>
    setPrefs(prev => ({ ...prev, ...patch }));

  const feedStyle = useMemo(() => {
    const style: React.CSSProperties = {};
    if (prefs.fontFamily !== 'system') {
      const f = FONT_OPTIONS.find(o => o.id === prefs.fontFamily);
      if (f) style.fontFamily = f.css;
    }
    if (prefs.textColor) style.color = prefs.textColor;
    if (prefs.bgColor) style.backgroundColor = prefs.bgColor;
    return style;
  }, [prefs]);

  return { prefs, update, feedStyle };
}
