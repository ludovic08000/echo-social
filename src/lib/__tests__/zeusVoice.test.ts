import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPendingZeusAnnouncement,
  isZeusVoiceUnlockedForSession,
  savePendingZeusAnnouncement,
  speakWithBrowserVoice,
  unlockZeusVoiceForSession,
} from '@/lib/zeusVoice';

class TestUtterance {
  lang = '';
  rate = 1;
  pitch = 1;
  volume = 1;
  voice: SpeechSynthesisVoice | null = null;

  constructor(readonly text: string) {}
}

describe('Zeus browser voice', () => {
  const speak = vi.fn();
  const cancel = vi.fn();

  beforeEach(() => {
    sessionStorage.clear();
    speak.mockReset();
    cancel.mockReset();
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        cancel,
        getVoices: () => [],
        speak,
      },
    });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      configurable: true,
      value: TestUtterance,
    });
  });

  it('keeps the audio unlock scoped to the current browser session', () => {
    expect(isZeusVoiceUnlockedForSession()).toBe(false);
    expect(unlockZeusVoiceForSession()).toBe(true);
    expect(isZeusVoiceUnlockedForSession()).toBe(true);
  });

  it('keeps only a bounded, non-audio pending announcement in session storage', () => {
    savePendingZeusAnnouncement('Bonjour, vous avez 2 messages non lus.');
    expect(getPendingZeusAnnouncement()).toBe('Bonjour, vous avez 2 messages non lus.');
  });

  it('speaks only a non-empty phrase with the requested safe browser settings', () => {
    expect(speakWithBrowserVoice('   ')).toBe(false);
    expect(speak).not.toHaveBeenCalled();

    expect(speakWithBrowserVoice('Bonjour, je suis Zeus.', {
      lang: 'fr-FR',
      rate: 1.1,
      volume: 0.6,
    })).toBe(true);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Bonjour, je suis Zeus.',
      lang: 'fr-FR',
      rate: 1.1,
      volume: 0.6,
    }));
  });
});
