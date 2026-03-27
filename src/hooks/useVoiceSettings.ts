import { useState, useEffect, useCallback } from 'react';

export interface VoiceSettings {
  voice_enabled: boolean;
  voice_messages_only: boolean;
  voice_live_only: boolean;
  voice_never_read_private: boolean;
  voice_volume: number;   // 0-1
  voice_speed: number;    // 0.5-2
  voice_lang: string;     // fr-FR, en-US, etc.
}

const STORAGE_KEY = 'forsure-voice-settings';

const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  voice_enabled: true,
  voice_messages_only: false,
  voice_live_only: false,
  voice_never_read_private: true,
  voice_volume: 0.7,
  voice_speed: 1.1,
  voice_lang: 'fr-FR',
};

function loadVoiceSettings(): VoiceSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_VOICE_SETTINGS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_VOICE_SETTINGS };
}

function saveVoiceSettings(s: VoiceSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {}
}

export function useVoiceSettings() {
  const [settings, setSettings] = useState<VoiceSettings>(loadVoiceSettings);

  const update = useCallback((partial: Partial<VoiceSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...partial };
      saveVoiceSettings(next);
      return next;
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
