export type RingtoneKind = 'audio' | 'video';

export interface RingtoneChoice {
  id: string;
  label: string;
  src: string;
}

export const DEFAULT_RINGTONES: RingtoneChoice[] = [
  { id: 'default', label: 'Classique', src: '/ringtones/default.mp3' },
  { id: 'soft', label: 'Soft', src: '/ringtones/soft.mp3' },
  { id: 'digital', label: 'Digital', src: '/ringtones/digital.mp3' },
  { id: 'club', label: 'Club', src: '/ringtones/club.mp3' },
];

const AUDIO_KEY = 'forsure:ringtone:audio';
const VIDEO_KEY = 'forsure:ringtone:video';

export function getRingtone(kind: RingtoneKind): RingtoneChoice {
  const key = kind === 'video' ? VIDEO_KEY : AUDIO_KEY;
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  return DEFAULT_RINGTONES.find(r => r.id === saved) || DEFAULT_RINGTONES[0];
}

export function setRingtone(kind: RingtoneKind, ringtoneId: string): void {
  const key = kind === 'video' ? VIDEO_KEY : AUDIO_KEY;
  if (typeof localStorage !== 'undefined') localStorage.setItem(key, ringtoneId);
}

export class RingtonePlayer {
  private audio: HTMLAudioElement | null = null;

  play(kind: RingtoneKind) {
    this.stop();
    const ringtone = getRingtone(kind);
    this.audio = new Audio(ringtone.src);
    this.audio.loop = true;
    this.audio.volume = 0.85;
    void this.audio.play().catch(() => undefined);
  }

  preview(ringtoneId: string) {
    this.stop();
    const ringtone = DEFAULT_RINGTONES.find(r => r.id === ringtoneId) || DEFAULT_RINGTONES[0];
    this.audio = new Audio(ringtone.src);
    this.audio.loop = false;
    this.audio.volume = 0.85;
    void this.audio.play().catch(() => undefined);
  }

  stop() {
    if (!this.audio) return;
    this.audio.pause();
    this.audio.currentTime = 0;
    this.audio = null;
  }
}
