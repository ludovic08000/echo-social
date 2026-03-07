import { useCallback, useRef, useEffect } from 'react';
import { useNotificationSettings } from '@/hooks/useNotificationSettings';

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

export function useNotificationSound() {
  const { data: settings } = useNotificationSettings();

  const playNotificationSound = useCallback((category?: 'message' | 'like' | 'comment' | 'friend_request') => {
    if (!settings?.sound_enabled) return;

    // Check category-specific settings
    if (category === 'message' && !settings.messages_enabled) return;
    if (category === 'like' && !settings.likes_enabled) return;
    if (category === 'comment' && !settings.comments_enabled) return;
    if (category === 'friend_request' && !settings.friend_requests_enabled) return;

    playTone((settings.sound_type as SoundType) || 'default');
  }, [settings]);

  return { playNotificationSound, playTone };
}

export function useRealtimeNotificationSound() {
  const { playNotificationSound } = useNotificationSound();
  const lastPlayedRef = useRef(0);

  const playWithThrottle = useCallback((category?: 'message' | 'like' | 'comment' | 'friend_request') => {
    const now = Date.now();
    if (now - lastPlayedRef.current < 2000) return; // throttle 2s
    lastPlayedRef.current = now;
    playNotificationSound(category);
  }, [playNotificationSound]);

  return playWithThrottle;
}

export const SOUND_OPTIONS = [
  { value: 'default', label: 'Par défaut' },
  { value: 'soft', label: 'Doux' },
  { value: 'bright', label: 'Lumineux' },
  { value: 'bubble', label: 'Bulle' },
  { value: 'chime', label: 'Carillon' },
] as const;
