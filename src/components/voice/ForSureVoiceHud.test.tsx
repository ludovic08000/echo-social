import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForSureVoiceHud } from './ForSureVoiceHud';

class FakeRecognition {
  static current: FakeRecognition | null = null;
  continuous = false;
  interimResults = false;
  lang = '';
  maxAlternatives = 0;
  onend: (() => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null = null;
  abort = vi.fn();
  stop = vi.fn();
  start = vi.fn();

  constructor() {
    FakeRecognition.current = this;
  }
}

const callbacks = {
  onClose: vi.fn(),
  onSpeakIntro: vi.fn(),
  onPrepareListening: vi.fn(),
  onSubmitCommand: vi.fn(),
};

function renderHud(overrides: Partial<ComponentProps<typeof ForSureVoiceHud>> = {}) {
  return render(<ForSureVoiceHud assistantName="Zeus" {...callbacks} {...overrides} />);
}

afterEach(() => {
  delete (window as Window & { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  FakeRecognition.current = null;
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('ForSureVoiceHud', () => {
  it('explains the confirmation boundary before a voice command can act', () => {
    renderHud();

    expect(screen.getByRole('dialog', { name: 'Bonjour, je suis Zeus' })).toHaveClass('fixed', 'inset-0', 'z-[100]');
    expect(screen.getByText('Confirmation requise')).toBeInTheDocument();
    expect(screen.getByText('Micro sur demande')).toBeInTheDocument();
    expect(screen.getByText('Pas d’audio stocké')).toBeInTheDocument();
  });

  it('starts recognition only after a direct tap and sends the final transcript directly to Zeus', async () => {
    vi.useFakeTimers();
    (window as Window & { webkitSpeechRecognition?: typeof FakeRecognition }).webkitSpeechRecognition = FakeRecognition;
    renderHud({ voiceAllowed: true, language: 'fr-FR' });

    fireEvent.click(screen.getByRole('button', { name: 'Parler à Zeus' }));

    expect(callbacks.onSpeakIntro).not.toHaveBeenCalled();
    expect(callbacks.onPrepareListening).toHaveBeenCalledOnce();
    expect(FakeRecognition.current?.start).toHaveBeenCalledTimes(1);
    expect(FakeRecognition.current?.lang).toBe('fr-FR');

    await act(async () => {
      FakeRecognition.current?.onresult?.({ results: [Object.assign([{ transcript: 'Prépare une publication' }], { isFinal: true })] });
      expect(callbacks.onSubmitCommand).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_500);
    });

    expect(screen.getByRole('textbox', { name: 'Votre demande à Zeus' })).toHaveValue('Prépare une publication');
    expect(callbacks.onSubmitCommand).toHaveBeenCalledWith('Prépare une publication', 'voice');
  });

  it('keeps a typed fallback when browser dictation is unavailable', () => {
    const onSubmitCommand = vi.fn();
    renderHud({ onSubmitCommand });

    fireEvent.change(screen.getByRole('textbox', { name: 'Votre demande à Zeus' }), {
      target: { value: 'Montre-moi plus de science' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Envoyer à Zeus' }));

    expect(onSubmitCommand).toHaveBeenCalledWith('Montre-moi plus de science', 'text');
  });

  it('does not open the microphone for a non-creator and keeps text available', () => {
    (window as Window & { webkitSpeechRecognition?: typeof FakeRecognition }).webkitSpeechRecognition = FakeRecognition;
    const onUpgrade = vi.fn();
    renderHud({ voiceAllowed: false, onUpgrade });
    fireEvent.click(screen.getByRole('button', { name: 'Découvrir les commandes vocales Créateur' }));
    expect(onUpgrade).toHaveBeenCalledOnce();
    expect(FakeRecognition.current).toBeNull();
    expect(callbacks.onSpeakIntro).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toBeEnabled();
  });

  it('releases an active microphone when the subscription is lost', () => {
    (window as Window & { webkitSpeechRecognition?: typeof FakeRecognition }).webkitSpeechRecognition = FakeRecognition;
    const { rerender } = renderHud({ voiceAllowed: true });
    fireEvent.click(screen.getByRole('button', { name: 'Parler à Zeus' }));
    const recognition = FakeRecognition.current;
    rerender(<ForSureVoiceHud assistantName="Zeus" {...callbacks} voiceAllowed={false} />);
    expect(recognition?.abort).toHaveBeenCalledOnce();
  });

  it('se ferme au clavier avec Échap', () => {
    const onClose = vi.fn();
    renderHud({ onClose });

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
