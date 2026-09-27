import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const uploadToR2Mock = vi.fn();
const encryptMediaMock = vi.fn();
const generateMediaKeyMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

vi.mock('@/lib/r2', () => ({
  fetchR2Object: vi.fn(),
  uploadToR2: (...args: unknown[]) => uploadToR2Mock(...args),
}));

vi.mock('@/lib/crypto/mediaEncrypt', () => ({
  generateMediaKey: (...args: unknown[]) => generateMediaKeyMock(...args),
  encryptMedia: (...args: unknown[]) => encryptMediaMock(...args),
  buildMediaMessageBody: (label: string, key: string) => `${label}\x00MKEY:${key}`,
}));

vi.mock('@/lib/messaging/e2eeTrace', () => ({
  traceE2EE: vi.fn(),
  traceE2EEBlock: async (_event: unknown, operation: () => Promise<unknown>) => operation(),
}));

vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => toastErrorMock(...args) },
}));

import { VoiceRecorder } from '@/components/chat/VoiceRecorder';
import { requestVoiceCaptureStream } from '@/lib/messaging/voiceCapture';

const trackStopMock = vi.fn();
const stream = {
  getTracks: () => [{ stop: trackStopMock }],
} as unknown as MediaStream;

class FakeMediaRecorder {
  static isTypeSupported(type: string) {
    return type.startsWith('audio/webm');
  }

  state: RecordingState = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  start() {
    this.state = 'recording';
  }

  requestData() {
    this.ondataavailable?.({
      data: new Blob(['voice-bytes'], { type: this.mimeType }),
    } as BlobEvent);
  }

  stop() {
    this.state = 'inactive';
    this.onstop?.();
  }
}

describe('VoiceRecorder', () => {
  const getUserMediaMock = vi.fn(async () => stream);

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: getUserMediaMock },
    });
    Object.defineProperty(window, 'MediaRecorder', {
      configurable: true,
      value: FakeMediaRecorder,
    });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:voice-preview'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    generateMediaKeyMock.mockResolvedValue({ key: {}, keyB64: 'voice-key' });
    encryptMediaMock.mockResolvedValue(
      new Blob(['encrypted-voice'], { type: 'application/octet-stream' }),
    );
    uploadToR2Mock.mockResolvedValue({
      url: 'https://media.example/voice.enc.webm',
      path: 'voice/voice.enc.webm',
    });
  });

  it('requests the stream synchronously from the user click helper', async () => {
    const pending = requestVoiceCaptureStream();
    expect(getUserMediaMock).toHaveBeenCalledWith({ audio: true });
    await expect(pending).resolves.toBe(stream);
  });

  it('uses the stream request already started by the parent click', async () => {
    const initialRequest = Promise.resolve(stream);
    render(
      <VoiceRecorder
        initialStreamRequest={initialRequest}
        onSend={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await screen.findByLabelText("Arrêter l'enregistrement vocal");
    expect(getUserMediaMock).not.toHaveBeenCalled();
  });

  it('keeps the recorded audio and reuses its upload when Aegis enqueue fails', async () => {
    const onSend = vi.fn()
      .mockRejectedValueOnce(new Error('AEGIS_DEVICE_ROUTE_UNAVAILABLE'))
      .mockResolvedValueOnce(undefined);

    render(
      <VoiceRecorder
        initialStreamRequest={Promise.resolve(stream)}
        onSend={onSend}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByLabelText("Arrêter l'enregistrement vocal"));
    const send = await screen.findByLabelText('Envoyer le message vocal');
    fireEvent.click(send);

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(uploadToR2Mock).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Envoyer le message vocal')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Envoyer le message vocal'));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(uploadToR2Mock).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[1]?.[2]).toContain('🎙️ voice:');
  });

  it('opens account-key recovery instead of exposing an archive error code', async () => {
    const restoreEvents: Array<Record<string, unknown>> = [];
    const onRestore = (event: Event) => {
      restoreEvents.push((event as CustomEvent<Record<string, unknown>>).detail);
    };
    window.addEventListener('forsure:e2ee-restore-needed', onRestore);

    try {
      render(
        <VoiceRecorder
          initialStreamRequest={Promise.resolve(stream)}
          onSend={vi.fn().mockRejectedValue(new Error('AEGIS_ARCHIVE_REQUIRED'))}
          onCancel={vi.fn()}
        />,
      );

      fireEvent.click(await screen.findByLabelText("Arrêter l'enregistrement vocal"));
      fireEvent.click(await screen.findByLabelText('Envoyer le message vocal'));

      await waitFor(() => expect(restoreEvents).toContainEqual(expect.objectContaining({
        userId: 'user-1',
        reason: 'account_master_key_locked',
        source: 'voice_message',
      })));
      expect(toastErrorMock).toHaveBeenCalledWith(
        'Votre coffre sécurisé doit être déverrouillé. Restaurez-le avec votre mot de passe puis réessayez.',
      );
      expect(toastErrorMock).not.toHaveBeenCalledWith(expect.stringContaining('AEGIS_ARCHIVE_REQUIRED'));
    } finally {
      window.removeEventListener('forsure:e2ee-restore-needed', onRestore);
    }
  });
});
