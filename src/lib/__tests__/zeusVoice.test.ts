import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPendingZeusAnnouncement,
  isZeusVoiceUnlockedForSession,
  prepareSpokenAssistantReply,
  savePendingZeusAnnouncement,
  speakWithBrowserVoice,
  speakAndWaitWithBrowserVoice,
  setZeusMicrophoneActive,
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
    setZeusMicrophoneActive(false);
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
  afterEach(() => { setZeusMicrophoneActive(false); vi.useRealTimers(); });

  it('waits for the real speech end event before allowing the next turn', async () => {
    vi.useFakeTimers();
    const done = vi.fn();
    const result = speakAndWaitWithBrowserVoice('Bonjour.').then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    const utterance = speak.mock.calls[0][0] as SpeechSynthesisUtterance;
    utterance.onend?.({} as SpeechSynthesisEvent);
    await result;
    expect(done).toHaveBeenCalledWith(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops a reply when the user pauses and ignores a late end event', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const result = speakAndWaitWithBrowserVoice('Bonjour.', {}, controller.signal);
    const utterance = speak.mock.calls[0][0] as SpeechSynthesisUtterance;
    controller.abort();
    utterance.onend?.({} as SpeechSynthesisEvent);
    expect(await result).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not play proactive speech into an active dictation microphone', async () => {
    setZeusMicrophoneActive(true);
    expect(speakWithBrowserVoice('Vous avez un message.')).toBe(false);
    expect(await speakAndWaitWithBrowserVoice('Bonjour.')).toBe(false);
    expect(speak).not.toHaveBeenCalled();
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

  it('keeps assistant speech human-readable and never narrates action payloads', () => {
    expect(prepareSpokenAssistantReply(
      'Voici une idée.\n```forsure-action\n{"type":"publish_post","body":"x"}\n```',
      'fallback',
    )).toBe('Voici une idée.');
    expect(prepareSpokenAssistantReply('```json\n{}\n```', 'fallback')).toBe('fallback');
  });
});
