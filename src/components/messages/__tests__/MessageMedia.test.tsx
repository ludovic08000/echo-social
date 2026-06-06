import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/components/messages/EncryptedMedia', () => ({
  EncryptedMedia: ({ encryptedUrl, mediaKeyB64 }: { encryptedUrl: string; mediaKeyB64: string }) => (
    <div data-testid="encrypted-media" data-url={encryptedUrl} data-key={mediaKeyB64} />
  ),
}));

vi.mock('@/lib/crypto/plaintextStore', () => ({
  loadPlaintext: vi.fn().mockResolvedValue(null),
}));

import { MessageMedia } from '@/components/messages/MessageMedia';
import { buildMediaMessageBody } from '@/lib/crypto/mediaEncrypt';
import { clearMediaKey, setMediaKey } from '@/components/messages/mediaKeyCache';

const URL = 'https://media.example.test/encrypted-photo.bin';
const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

describe('MessageMedia E2EE gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMediaKey('msg-media');
    clearMediaKey('msg-cache');
    clearMediaKey('msg-clear-body');
  });

  it('does not render raw media URL in an encrypted conversation when the media key is missing', async () => {
    render(
      <MessageMedia
        imageUrl={URL}
        body="Photo"
        decrypt={vi.fn().mockResolvedValue({ text: '', incompatible: true })}
        isEncryptionActive={true}
        messageId="msg-media"
      />,
    );

    expect(await screen.findByText('Média chiffré en attente de clé')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(document.querySelector('video')).toBeNull();
    expect(screen.queryByTestId('encrypted-media')).not.toBeInTheDocument();
  });

  it('ignores a clear MKEY embedded in the server body while E2EE is active', async () => {
    render(
      <MessageMedia
        imageUrl={URL}
        body={buildMediaMessageBody('Photo', KEY)}
        decrypt={vi.fn()}
        isEncryptionActive={true}
        messageId="msg-clear-body"
      />,
    );

    expect(await screen.findByText('Média chiffré en attente de clé')).toBeInTheDocument();
    expect(screen.queryByTestId('encrypted-media')).not.toBeInTheDocument();
  });

  it('renders encrypted media when the key arrives through the trusted cache', async () => {
    const { rerender } = render(
      <MessageMedia
        imageUrl={URL}
        body={JSON.stringify({ encryptionMode: 'multi_device', v: 4, ct: 'device_copies', ts: Date.now() })}
        decrypt={vi.fn()}
        isEncryptionActive={true}
        messageId="msg-cache"
      />,
    );

    act(() => {
      setMediaKey('msg-cache', KEY, false);
    });
    rerender(
      <MessageMedia
        imageUrl={URL}
        body={JSON.stringify({ encryptionMode: 'multi_device', v: 4, ct: 'device_copies', ts: Date.now() })}
        decrypt={vi.fn()}
        isEncryptionActive={true}
        messageId="msg-cache"
      />,
    );

    await waitFor(() => expect(screen.getByTestId('encrypted-media')).toHaveAttribute('data-key', KEY));
  });
});
