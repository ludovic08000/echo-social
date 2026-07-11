import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const resolvePlaintext = vi.fn();
const clearNegativeCache = vi.fn();
const dropCache = vi.fn();

vi.mock('@/components/messages/decryptionService', () => ({
  resolvePlaintext,
  clearNegativeCache,
  dropCache,
  readCache: vi.fn(() => undefined),
  persistOutcome: vi.fn((_body: string, outcome: { text: string }) => outcome.text),
  looksEncrypted: vi.fn(() => true),
  buildOutcomeFromText: vi.fn((text: string) => ({ text, mediaKeyB64: null, hidden: false })),
}));

vi.mock('@/components/chat/VoiceRecorder', () => ({ VoiceMessagePlayer: () => null }));
vi.mock('@/components/messages/mediaKeyCache', () => ({ setMediaKey: vi.fn() }));

import { DecryptedMessageBody } from '@/components/messages/DecryptedMessageBody';

describe('DecryptedMessageBody recovery state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resolvePlaintext.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('shows a neutral recovery state instead of an empty bubble', async () => {
    await act(async () => {
      render(
        <DecryptedMessageBody
          body="encrypted"
          decrypt={vi.fn()}
          isEncryptionActive
          messageId="message-a"
        />,
      );
    });

    expect(screen.getByText('Message en cours de récupération…')).toBeInTheDocument();
  });

  it('shows an explicit retry action after the bounded recovery window', async () => {
    await act(async () => {
      render(
        <DecryptedMessageBody
          body="encrypted"
          decrypt={vi.fn()}
          isEncryptionActive
          messageId="message-b"
        />,
      );
    });

    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });

    expect(screen.getByText('Message chiffré indisponible sur cet appareil.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(clearNegativeCache).toHaveBeenCalled();
    expect(dropCache).toHaveBeenCalledWith('message-b', 'encrypted');
    expect(screen.getByText('Message en cours de récupération…')).toBeInTheDocument();
  });

  it('ignores retry events targeting another message', async () => {
    await act(async () => {
      render(
        <DecryptedMessageBody
          body="encrypted"
          decrypt={vi.fn()}
          isEncryptionActive
          messageId="message-c"
        />,
      );
    });

    const callsBefore = resolvePlaintext.mock.calls.length;
    act(() => {
      window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', { detail: { messageId: 'other-message' } }));
    });
    expect(resolvePlaintext.mock.calls.length).toBe(callsBefore);
  });
});
