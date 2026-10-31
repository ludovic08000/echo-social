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
  start = vi.fn();

  constructor() {
    FakeRecognition.current = this;
  }
}

const callbacks = {
  onClose: vi.fn(),
  onSpeakIntro: vi.fn(),
  onSubmitCommand: vi.fn(),
};

function renderHud(overrides: Partial<ComponentProps<typeof ForSureVoiceHud>> = {}) {
  return render(<ForSureVoiceHud assistantName="Zeus" {...callbacks} {...overrides} />);
}

afterEach(() => {
  delete (window as Window & { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  FakeRecognition.current = null;
  vi.clearAllMocks();
});

describe('ForSureVoiceHud', () => {
  it('explains the confirmation boundary before a voice command can act', () => {
    renderHud();

    expect(screen.getByRole('dialog', { name: 'Parlez à Zeus' })).toBeInTheDocument();
    expect(screen.getByText('Confirmation requise')).toBeInTheDocument();
    expect(screen.getByText('Micro sur demande')).toBeInTheDocument();
    expect(screen.getByText('Pas d’audio stocké')).toBeInTheDocument();
  });

  it('starts recognition only after a direct tap and lets the user review the transcript', () => {
    (window as Window & { webkitSpeechRecognition?: typeof FakeRecognition }).webkitSpeechRecognition = FakeRecognition;
    renderHud();

    fireEvent.click(screen.getByRole('button', { name: 'Dicter une demande' }));

    expect(callbacks.onSpeakIntro).toHaveBeenCalledTimes(1);
    expect(FakeRecognition.current?.start).toHaveBeenCalledTimes(1);

    act(() => {
      FakeRecognition.current?.onresult?.({ results: [[{ transcript: 'Prépare une publication' }]] });
    });

    expect(screen.getByRole('textbox', { name: 'Votre demande à Zeus' })).toHaveValue('Prépare une publication');
  });

  it('keeps a typed fallback when browser dictation is unavailable', () => {
    const onSubmitCommand = vi.fn();
    renderHud({ onSubmitCommand });

    fireEvent.change(screen.getByRole('textbox', { name: 'Votre demande à Zeus' }), {
      target: { value: 'Montre-moi plus de science' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Envoyer à Zeus' }));

    expect(onSubmitCommand).toHaveBeenCalledWith('Montre-moi plus de science');
  });

  it('se ferme au clavier avec Échap', () => {
    const onClose = vi.fn();
    renderHud({ onClose });

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
