import { useCallback, useSyncExternalStore } from 'react';

export interface VoiceSettings {
  voice_enabled: boolean;
  /** Set only by an explicit user interaction; older defaults do not count as consent. */
  voice_consent_version: 1;
  voice_messages_only: boolean;
  voice_live_only: boolean;
  voice_never_read_private: boolean;
  voice_volume: number;   // 0-1
  voice_speed: number;    // 0.5-2
  voice_lang: string;     // fr-FR, en-US, etc.
}

const STORAGE_KEY = 'forsure-voice-settings';
const SETTINGS_EVENT = 'forsure:voice-settings-changed';

const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  voice_enabled: false,
  voice_consent_version: 1,
  voice_messages_only: false,
  voice_live_only: false,
  voice_never_read_private: true,
  voice_volume: 0.7,
  voice_speed: 1.1,
  voice_lang: 'fr-FR',
};

let cachedRaw: string | null | undefined;
let cachedSettings: VoiceSettings = DEFAULT_VOICE_SETTINGS;

function loadVoiceSettings(): VoiceSettings {
  if (typeof window === 'undefined') return DEFAULT_VOICE_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === cachedRaw) return cachedSettings;
    cachedRaw = raw;
    if (raw) {
      const stored = JSON.parse(raw) as Partial<VoiceSettings>;
      // Releases before this setting used an implicit `true` default. Audio is
      // now opt-in because Safari/iOS requires a real tap and private alerts
      // must never start speaking merely after an upgrade.
      const hasExplicitConsent = stored.voice_consent_version === 1;
      cachedSettings = {
        ...DEFAULT_VOICE_SETTINGS,
        ...stored,
        voice_enabled: hasExplicitConsent ? stored.voice_enabled === true : false,
        voice_consent_version: 1,
      };
      return cachedSettings;
    }
    cachedSettings = DEFAULT_VOICE_SETTINGS;
    return cachedSettings;
  } catch {
    cachedRaw = undefined;
    cachedSettings = DEFAULT_VOICE_SETTINGS;
    return cachedSettings;
  }
}

function saveVoiceSettings(s: VoiceSettings) {
  try {
    const raw = JSON.stringify(s);
    localStorage.setItem(STORAGE_KEY, raw);
    cachedRaw = raw;
    cachedSettings = s;
    window.dispatchEvent(new Event(SETTINGS_EVENT));
  } catch {
    // Local preferences are optional; the default remains safe.
  }
}

function subscribe(listener: () => void) {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  window.addEventListener(SETTINGS_EVENT, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(SETTINGS_EVENT, listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function useVoiceSettings() {
  const settings = useSyncExternalStore(subscribe, loadVoiceSettings, () => DEFAULT_VOICE_SETTINGS);

  const update = useCallback((partial: Partial<VoiceSettings>) => {
    saveVoiceSettings({
      ...loadVoiceSettings(),
      ...partial,
      voice_consent_version: 1,
    });
  }, []);

  return { voiceSettings: settings, updateVoiceSettings: update };
}

/**
 * Check if voice should speak for a given notification category.
 */
export function shouldSpeak(settings: VoiceSettings, category?: string): boolean {
  if (!settings.voice_enabled) return false;
  if (settings.voice_messages_only && category !== 'message') return false;
  if (settings.voice_live_only && category !== 'live') return false;
  return true;
}

export const VOICE_LANG_OPTIONS = [
  { value: 'fr-FR', label: 'Français' },
  { value: 'en-US', label: 'English' },
  { value: 'es-ES', label: 'Español' },
  { value: 'de-DE', label: 'Deutsch' },
] as const;
