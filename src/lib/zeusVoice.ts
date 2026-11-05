const VOICE_UNLOCKED_SESSION_KEY = 'forsure:zeus-voice-unlocked:v1';
const PENDING_ANNOUNCEMENT_SESSION_KEY = 'forsure:zeus-voice-pending-announcement:v1';
const MAX_SPOKEN_REPLY_LENGTH = 1_100;

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

export function stopBrowserVoice(): void {
  if (!isBrowserVoiceSupported()) return;
  try { window.speechSynthesis.cancel(); } catch { /* Browser audio may already be closed. */ }
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

/**
 * Keeps spoken AI answers natural and bounded. Tool/action payloads are UI-only
 * and must never be narrated as JSON or executable instructions.
 */
export function prepareSpokenAssistantReply(content: string, fallback: string): string {
  const cleaned = content
    .replace(/```(?:forsure-action|forsure-products|json)?\s*[\s\S]*?```/gi, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return fallback;
  if (cleaned.length <= MAX_SPOKEN_REPLY_LENGTH) return cleaned;

  const prefix = cleaned.slice(0, MAX_SPOKEN_REPLY_LENGTH);
  const lastSentence = Math.max(prefix.lastIndexOf('.'), prefix.lastIndexOf('!'), prefix.lastIndexOf('?'));
  const bounded = (lastSentence > 500 ? prefix.slice(0, lastSentence + 1) : prefix).trim();
  return `${bounded} La suite est affichée à l’écran.`;
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
