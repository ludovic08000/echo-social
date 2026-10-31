const VOICE_UNLOCKED_SESSION_KEY = 'forsure:zeus-voice-unlocked:v1';
const PENDING_ANNOUNCEMENT_SESSION_KEY = 'forsure:zeus-voice-pending-announcement:v1';

export interface BrowserVoiceOptions {
  lang?: string;
  rate?: number;
  volume?: number;
  pitch?: number;
}

function getSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function isBrowserVoiceSupported(): boolean {
  return typeof window !== 'undefined'
    && 'speechSynthesis' in window
    && 'SpeechSynthesisUtterance' in window;
}

/**
 * iOS only permits reliable speech after a direct user gesture. This marker is
 * deliberately session-scoped: it does not pretend that a past tap gives the
 * browser perpetual audio permission after a full reload.
 */
export function unlockZeusVoiceForSession(): boolean {
  if (!isBrowserVoiceSupported()) return false;
  try {
    getSessionStorage()?.setItem(VOICE_UNLOCKED_SESSION_KEY, '1');
  } catch {
    // A private browser can deny storage. The caller can still speak during
    // its current click handler, which is enough to satisfy browser policy.
  }
  return true;
}

export function isZeusVoiceUnlockedForSession(): boolean {
  try {
    return getSessionStorage()?.getItem(VOICE_UNLOCKED_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

export function savePendingZeusAnnouncement(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  try {
    getSessionStorage()?.setItem(PENDING_ANNOUNCEMENT_SESSION_KEY, trimmed.slice(0, 500));
  } catch {
    // The toast remains usable even when private-mode storage is unavailable.
  }
}

export function getPendingZeusAnnouncement(): string | null {
  try {
    return getSessionStorage()?.getItem(PENDING_ANNOUNCEMENT_SESSION_KEY) || null;
  } catch {
    return null;
  }
}

export function speakWithBrowserVoice(text: string, options: BrowserVoiceOptions = {}): boolean {
  const phrase = text.trim();
  if (!phrase || !isBrowserVoiceSupported()) return false;

  try {
    const synth = window.speechSynthesis;
    synth.cancel();

    const utterance = new SpeechSynthesisUtterance(phrase);
    const lang = options.lang || 'fr-FR';
    utterance.lang = lang;
    utterance.rate = options.rate ?? 1;
    utterance.pitch = options.pitch ?? 1;
    utterance.volume = options.volume ?? 0.7;

    const langPrefix = lang.split('-')[0];
    const voices = synth.getVoices();
    const selectedVoice = voices.find((voice) => voice.lang === lang)
      || voices.find((voice) => voice.lang.startsWith(langPrefix));
    if (selectedVoice) utterance.voice = selectedVoice;

    synth.speak(utterance);
    return true;
  } catch {
    return false;
  }
}
