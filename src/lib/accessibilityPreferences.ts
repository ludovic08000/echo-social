export interface AccessibilityPreferences {
  reducedMotion: boolean;
  highContrast: boolean;
  screenReaderOptimized: boolean;
  largeClickTargets: boolean;
  keyboardNavigation: boolean;
  autoplayVideos: boolean;
  captionsEnabled: boolean;
  colorBlindMode: 'none' | 'deuteranopia' | 'protanopia' | 'tritanopia';
  language: string;
  lineSpacing: number;
}

export const ACCESSIBILITY_STORAGE_KEY = 'accessibility-prefs';
export const ACCESSIBILITY_CHANGED_EVENT = 'forsure:accessibility-changed';

export const DEFAULT_ACCESSIBILITY_PREFERENCES: AccessibilityPreferences = {
  reducedMotion: false,
  highContrast: false,
  screenReaderOptimized: false,
  largeClickTargets: false,
  keyboardNavigation: false,
  autoplayVideos: true,
  captionsEnabled: false,
  colorBlindMode: 'none',
  language: 'fr',
  lineSpacing: 1.5,
};

function normalize(value: Partial<AccessibilityPreferences> | null | undefined): AccessibilityPreferences {
  const colorBlindMode = ['none', 'deuteranopia', 'protanopia', 'tritanopia'].includes(String(value?.colorBlindMode))
    ? value?.colorBlindMode as AccessibilityPreferences['colorBlindMode']
    : 'none';
  const lineSpacing = Number(value?.lineSpacing);
  return {
    ...DEFAULT_ACCESSIBILITY_PREFERENCES,
    ...value,
    colorBlindMode,
    lineSpacing: Number.isFinite(lineSpacing) ? Math.min(2.5, Math.max(1, lineSpacing)) : 1.5,
  };
}

export function readAccessibilityPreferences(): AccessibilityPreferences {
  if (typeof window === 'undefined') return { ...DEFAULT_ACCESSIBILITY_PREFERENCES };
  try {
    const raw = window.localStorage.getItem(ACCESSIBILITY_STORAGE_KEY);
    return normalize(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_ACCESSIBILITY_PREFERENCES };
  }
}

export function applyAccessibilityPreferences(prefs = readAccessibilityPreferences()) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('reduced-motion', prefs.reducedMotion);
  root.classList.toggle('high-contrast', prefs.highContrast);
  root.classList.toggle('large-targets', prefs.largeClickTargets);
  root.classList.toggle('screen-reader-optimized', prefs.screenReaderOptimized);
  root.classList.toggle('keyboard-navigation', prefs.keyboardNavigation);
  root.dataset.colorBlindMode = prefs.colorBlindMode;
  root.dataset.captionsEnabled = String(prefs.captionsEnabled);
  root.style.setProperty('--line-height-factor', String(prefs.lineSpacing));

  document.querySelectorAll<HTMLVideoElement>('video').forEach((video) => {
    for (const track of Array.from(video.textTracks || [])) {
      if (track.kind === 'captions' || track.kind === 'subtitles') {
        track.mode = prefs.captionsEnabled ? 'showing' : 'disabled';
      }
    }
  });
}

export function saveAccessibilityPreferences(prefs: AccessibilityPreferences) {
  const next = normalize(prefs);
  try {
    window.localStorage.setItem(ACCESSIBILITY_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Restricted browser storage: settings still apply for this session.
  }
  applyAccessibilityPreferences(next);
  window.dispatchEvent(new CustomEvent(ACCESSIBILITY_CHANGED_EVENT, { detail: next }));
}

export function subscribeAccessibilityPreferences(listener: (prefs: AccessibilityPreferences) => void) {
  if (typeof window === 'undefined') return () => undefined;
  const onChanged = (event: Event) => {
    listener((event as CustomEvent<AccessibilityPreferences>).detail || readAccessibilityPreferences());
  };
  const onStorage = (event: StorageEvent) => {
    if (!event.key || event.key === ACCESSIBILITY_STORAGE_KEY) {
      const prefs = readAccessibilityPreferences();
      applyAccessibilityPreferences(prefs);
      listener(prefs);
    }
  };
  window.addEventListener(ACCESSIBILITY_CHANGED_EVENT, onChanged);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(ACCESSIBILITY_CHANGED_EVENT, onChanged);
    window.removeEventListener('storage', onStorage);
  };
}
