import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  resolvePlaintext: vi.fn(),
  clearNegativeCache: vi.fn(),
  dropCache: vi.fn(),
}));

vi.mock('@/components/messages/decryptionService', () => ({
  resolvePlaintext: mocks.resolvePlaintext,
  clearNegativeCache: mocks.clearNegativeCache,
  dropCache: mocks.dropCache,
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
    mocks.resolvePlaintext.mockResolvedValue(null);
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
    expect(mocks.clearNegativeCache).toHaveBeenCalledWith('message-b', 'encrypted');
    expect(mocks.dropCache).toHaveBeenCalledWith('message-b', 'encrypted');
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

    const callsBefore = mocks.resolvePlaintext.mock.calls.length;
    act(() => {
      window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', { detail: { messageId: 'other-message' } }));
    });
    expect(mocks.resolvePlaintext.mock.calls.length).toBe(callsBefore);
  });
});
