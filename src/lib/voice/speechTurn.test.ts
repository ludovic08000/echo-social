import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSpeechTurn, type BrowserRecognition, type RecognitionResult } from './speechTurn';

function fixture() {
  vi.useFakeTimers();
  const recognition: BrowserRecognition = {
    continuous: false, interimResults: false, lang: '', maxAlternatives: 0,
    onend: null, onerror: null, onresult: null,
    start: vi.fn(), stop: vi.fn(), abort: vi.fn(),
  };
  const callbacks = { language: 'fr-FR', onTranscript: vi.fn(), onComplete: vi.fn(), onError: vi.fn() };
  const turn = createSpeechTurn(recognition, callbacks);
  const emit = (...parts: [string, boolean][]) => recognition.onresult?.({
    results: parts.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal }) as RecognitionResult),
  });
  turn.start();
  return { recognition, callbacks, turn, emit };
}
afterEach(() => vi.useRealTimers());

describe('one complete speech turn', () => {
  it('uses the selected language and permits more than one phrase', () => {
    const { recognition } = fixture();
    expect(recognition).toMatchObject({ lang: 'fr-FR', continuous: true, interimResults: true });
  });
  it('shows interim hypotheses without ever sending them automatically', () => {
    const { emit, callbacks, turn } = fixture();
    emit(['envoie un message à', false]);
    vi.advanceTimersByTime(5_000);
    expect(callbacks.onTranscript).toHaveBeenLastCalledWith('envoie un message à');
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    turn.abort();
  });
  it('waits across a pause and replaces interim words instead of duplicating them', () => {
    const { emit, callbacks } = fixture();
    emit(['Envoie un message à', true]);
    vi.advanceTimersByTime(1_000);
    emit(['Envoie un message à', true], ['Nadia', false]);
    vi.advanceTimersByTime(2_000);
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    emit(['Envoie un message à', true], ['Nadège Loynet : salut, ça va ?', true]);
    vi.advanceTimersByTime(1_500);
    expect(callbacks.onComplete).toHaveBeenCalledExactlyOnceWith('Envoie un message à Nadège Loynet : salut, ça va ?');
  });
  it('ignores delayed result and end callbacks after the turn has completed', () => {
    const { emit, recognition, callbacks } = fixture();
    emit(['Bonjour', true]);
    const lateResult = recognition.onresult, lateEnd = recognition.onend;
    vi.advanceTimersByTime(1_500);
    lateResult?.({ results: [Object.assign([{ transcript: 'Bonjour' }], { isFinal: true })] });
    lateEnd?.();
    vi.advanceTimersByTime(3_000);
    expect(callbacks.onComplete).toHaveBeenCalledExactlyOnceWith('Bonjour');
  });
  it('sends one final phrase if the browser ends recognition itself', () => {
    const { emit, recognition, callbacks } = fixture();
    emit(['Montre-moi plus de science', true]);
    recognition.onend?.();
    vi.advanceTimersByTime(2_000);
    expect(callbacks.onComplete).toHaveBeenCalledExactlyOnceWith('Montre-moi plus de science');
  });
  it('keeps an unfinished phrase as a draft instead of sending a truncated command', () => {
    const { emit, recognition, callbacks } = fixture();
    emit(['Envoie un message', true], ['à', false]);
    recognition.onend?.();
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenCalledWith('incomplete');
  });
  it('waits for finalization after the user asks to finish', () => {
    const { emit, recognition, callbacks, turn } = fixture();
    emit(['Publie ma', false]);
    turn.finish();
    expect(recognition.stop).toHaveBeenCalledOnce();
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    emit(['Publie ma sortie sportive', true]);
    recognition.onend?.();
    expect(callbacks.onComplete).toHaveBeenCalledExactlyOnceWith('Publie ma sortie sportive');
  });
  it('never sends a pending phrase after a network error', () => {
    const { emit, recognition, callbacks } = fixture();
    emit(['Envoie un message à Nadège', true]);
    recognition.onerror?.({ error: 'network' });
    vi.advanceTimersByTime(3_000);
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenCalledWith('network');
  });
  it('stops all timers and callbacks when the assistant is closed or access revoked', () => {
    const { emit, recognition, callbacks, turn } = fixture();
    emit(['Ne pas envoyer', true]);
    turn.abort(); turn.abort();
    vi.advanceTimersByTime(50_000);
    expect(recognition.abort).toHaveBeenCalledOnce();
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
  });
  it('bounds microphone use even when the recognizer never ends', () => {
    const { recognition, callbacks } = fixture();
    vi.advanceTimersByTime(45_000);
    expect(recognition.stop).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2_000);
    expect(recognition.abort).toHaveBeenCalledOnce();
    expect(callbacks.onError).toHaveBeenCalledWith('incomplete');
  });
  it('does not silently send a command truncated at the character limit', () => {
    const { emit, callbacks } = fixture();
    emit(['x'.repeat(2_001), true]);
    vi.advanceTimersByTime(2_000);
    expect(callbacks.onError).toHaveBeenCalledWith('too-long');
    expect(callbacks.onComplete).not.toHaveBeenCalled();
  });
});
