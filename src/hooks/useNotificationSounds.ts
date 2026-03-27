import { useCallback, useRef, useEffect } from 'react';
import { useNotificationSettings } from '@/hooks/useNotificationSettings';
import { useVoiceSettings, shouldSpeak } from '@/hooks/useVoiceSettings';

// Simple tone generator using Web Audio API
const audioCtxRef: { current: AudioContext | null } = { current: null };

function getAudioCtx() {
  if (!audioCtxRef.current) {
    audioCtxRef.current = new AudioContext();
  }
  return audioCtxRef.current;
}

type SoundType = 'default' | 'soft' | 'bright' | 'bubble' | 'chime';

const SOUND_CONFIGS: Record<SoundType, { freq: number; freq2?: number; duration: number; type: OscillatorType; gain: number }> = {
  default: { freq: 880, freq2: 1100, duration: 0.15, type: 'sine', gain: 0.3 },
  soft: { freq: 523, duration: 0.2, type: 'sine', gain: 0.2 },
  bright: { freq: 1200, freq2: 1600, duration: 0.12, type: 'triangle', gain: 0.25 },
  bubble: { freq: 600, freq2: 900, duration: 0.18, type: 'sine', gain: 0.25 },
  chime: { freq: 1047, freq2: 1319, duration: 0.25, type: 'sine', gain: 0.2 },
};

function playTone(soundType: SoundType = 'default') {
  try {
    const ctx = getAudioCtx();
    const config = SOUND_CONFIGS[soundType] || SOUND_CONFIGS.default;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = config.type;
    osc.frequency.setValueAtTime(config.freq, now);
    if (config.freq2) {
      osc.frequency.linearRampToValueAtTime(config.freq2, now + config.duration * 0.5);
    }
    gain.gain.setValueAtTime(config.gain, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + config.duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + config.duration);
  } catch (e) {
    // Silently fail if audio context not available
  }
}

// ─── Voice synthesis (Web Speech API) ───

// Short, natural phrases per category – NO private content
const VOICE_PHRASES: Record<string, string> = {
  message: 'Nouveau message',
  like: 'Nouveau like',
  comment: 'Nouveau commentaire',
  friend_request: "Nouvelle demande d'ami",
  friend_accepted: 'Ami accepté',
  post: 'Nouvelle publication',
  live: 'Un live vient de démarrer',
  default: 'Nouvelle notification',
};

const VOICE_PHRASES_EN: Record<string, string> = {
  message: 'New message',
  like: 'New like',
  comment: 'New comment',
  friend_request: 'New friend request',
  friend_accepted: 'Friend accepted',
  post: 'New post',
  live: 'A live just started',
  default: 'New notification',
};

const VOICE_PHRASES_ES: Record<string, string> = {
  message: 'Nuevo mensaje',
  like: 'Nuevo like',
  comment: 'Nuevo comentario',
  friend_request: 'Nueva solicitud de amistad',
  post: 'Nueva publicación',
  live: 'Un directo acaba de empezar',
  default: 'Nueva notificación',
};

const VOICE_PHRASES_DE: Record<string, string> = {
  message: 'Neue Nachricht',
  like: 'Neues Like',
  comment: 'Neuer Kommentar',
  friend_request: 'Neue Freundschaftsanfrage',
  post: 'Neuer Beitrag',
  live: 'Ein Livestream hat begonnen',
  default: 'Neue Benachrichtigung',
};

// Grouped phrasing: "3 nouveaux messages"
const VOICE_GROUPED: Record<string, Record<string, string>> = {
  'fr-FR': { message: 'nouveaux messages', like: 'nouveaux likes', comment: 'nouveaux commentaires', default: 'nouvelles notifications' },
  'en-US': { message: 'new messages', like: 'new likes', comment: 'new comments', default: 'new notifications' },
  'es-ES': { message: 'nuevos mensajes', like: 'nuevos likes', comment: 'nuevos comentarios', default: 'nuevas notificaciones' },
  'de-DE': { message: 'neue Nachrichten', like: 'neue Likes', comment: 'neue Kommentare', default: 'neue Benachrichtigungen' },
};

// "from" preposition per lang
const FROM_WORD: Record<string, string> = { 'fr-FR': 'de', 'en-US': 'from', 'es-ES': 'de', 'de-DE': 'von' };

function getPhrasesForLang(lang: string): Record<string, string> {
  if (lang.startsWith('en')) return VOICE_PHRASES_EN;
  if (lang.startsWith('es')) return VOICE_PHRASES_ES;
  if (lang.startsWith('de')) return VOICE_PHRASES_DE;
  return VOICE_PHRASES;
}

let voiceSynthAvailable: boolean | null = null;

function isVoiceAvailable(): boolean {
  if (voiceSynthAvailable !== null) return voiceSynthAvailable;
  voiceSynthAvailable = typeof window !== 'undefined' && 'speechSynthesis' in window;
  return voiceSynthAvailable;
}

export interface SpeakOptions {
  volume?: number;
  speed?: number;
  lang?: string;
  senderName?: string;
  count?: number;
}

/**
 * Build a natural, short phrase.
 * count=1: "Nouveau message de Julien"
 * count=3: "3 nouveaux messages"
 */
function buildPhrase(category: string | undefined, lang: string, senderName?: string, count?: number): string {
  const cat = category || 'default';

  // Grouped: "N nouveaux messages"
  if (count && count > 1) {
    const langKey = Object.keys(VOICE_GROUPED).find(k => lang.startsWith(k.split('-')[0])) || 'fr-FR';
    const grouped = VOICE_GROUPED[langKey] || VOICE_GROUPED['fr-FR'];
    const noun = grouped[cat] || grouped.default;
    return `${count} ${noun}`;
  }

  // Single with sender name: "Nouveau message de Julien"
  const phrases = getPhrasesForLang(lang);
  const base = phrases[cat] || phrases.default;

  if (senderName && cat !== 'default' && cat !== 'live') {
    const from = FROM_WORD[lang] || FROM_WORD[Object.keys(FROM_WORD).find(k => lang.startsWith(k.split('-')[0])) || 'fr-FR'];
    return `${base} ${from} ${senderName}`;
  }

  return base;
}

export function speakNotification(
  category?: string,
  options?: SpeakOptions
) {
  if (!isVoiceAvailable()) return;

  try {
    const synth = window.speechSynthesis;
    synth.cancel();

    const lang = options?.lang || 'fr-FR';
    const phrase = buildPhrase(category, lang, options?.senderName, options?.count);
    const utterance = new SpeechSynthesisUtterance(phrase);
    utterance.lang = lang;
    utterance.rate = options?.speed ?? 1.1;
    utterance.pitch = 1.0;
    utterance.volume = options?.volume ?? 0.7;

    // Pick best voice for the language
    const voices = synth.getVoices();
    const langPrefix = lang.split('-')[0];
    const matchVoice = voices.find(v => v.lang === lang)
      || voices.find(v => v.lang.startsWith(langPrefix))
      || voices[0];
    if (matchVoice) utterance.voice = matchVoice;

    synth.speak(utterance);
  } catch {
    // Silent fail
  }
}

// ─── Tab visibility helper ───
function isTabActive(): boolean {
  if (typeof document === 'undefined') return true;
  return !document.hidden;
}

export function useNotificationSound() {
  const { data: settings } = useNotificationSettings();

  const playNotificationSound = useCallback((category?: 'message' | 'like' | 'comment' | 'friend_request') => {
    if (!settings?.sound_enabled) return;

    if (category === 'message' && !settings.messages_enabled) return;
    if (category === 'like' && !settings.likes_enabled) return;
    if (category === 'comment' && !settings.comments_enabled) return;
    if (category === 'friend_request' && !settings.friend_requests_enabled) return;

    playTone((settings.sound_type as SoundType) || 'default');
  }, [settings]);

  return { playNotificationSound, playTone };
}

// ─── Smart grouping + throttle ───
interface PendingNotif {
  category: string;
  senderName?: string;
}

export function useRealtimeNotificationSound() {
  const { playNotificationSound } = useNotificationSound();
  const { data: settings } = useNotificationSettings();
  const { voiceSettings } = useVoiceSettings();
  const lastPlayedRef = useRef(0);
  const pendingRef = useRef<PendingNotif[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pre-load voices
  useEffect(() => {
    if (isVoiceAvailable()) {
      window.speechSynthesis.getVoices();
    }
  }, []);

  // Flush grouped notifications
  const flushPending = useCallback(() => {
    const items = pendingRef.current;
    pendingRef.current = [];
    flushTimerRef.current = null;
    if (items.length === 0) return;

    // Group by category
    const groups = new Map<string, PendingNotif[]>();
    for (const item of items) {
      const key = item.category || 'default';
      const arr = groups.get(key) || [];
      arr.push(item);
      groups.set(key, arr);
    }

    // Play sound once
    const firstCat = items[0].category as 'message' | 'like' | 'comment' | 'friend_request' | undefined;
    playNotificationSound(firstCat);

    // Speak only if tab is NOT active (or sound is enabled and voice is on)
    if (settings?.sound_enabled !== false && shouldSpeak(voiceSettings)) {
      setTimeout(() => {
        // Announce each category group
        for (const [cat, group] of groups) {
          const count = group.length;
          const senderName = count === 1 ? group[0].senderName : undefined;
          if (shouldSpeak(voiceSettings, cat)) {
            speakNotification(cat, {
              volume: voiceSettings.voice_volume,
              speed: voiceSettings.voice_speed,
              lang: voiceSettings.voice_lang,
              senderName,
              count,
            });
          }
        }
      }, 300);
    }
  }, [playNotificationSound, settings, voiceSettings]);

  const enqueue = useCallback((category?: string, senderName?: string) => {
    const now = Date.now();

    pendingRef.current.push({ category: category || 'default', senderName });

    // If first in batch or enough time passed, schedule flush
    if (!flushTimerRef.current) {
      const elapsed = now - lastPlayedRef.current;
      // If recent notification was <3s ago, batch more aggressively
      const delay = elapsed < 3000 ? 2500 : 400;
      lastPlayedRef.current = now;
      flushTimerRef.current = setTimeout(flushPending, delay);
    }
  }, [flushPending]);

  return enqueue;
}

export const SOUND_OPTIONS = [
  { value: 'default', label: 'Par défaut' },
  { value: 'soft', label: 'Doux' },
  { value: 'bright', label: 'Lumineux' },
  { value: 'bubble', label: 'Bulle' },
  { value: 'chime', label: 'Carillon' },
] as const;
