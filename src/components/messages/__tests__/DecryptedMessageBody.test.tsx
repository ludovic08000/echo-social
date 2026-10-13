/**
 * DecryptedMessageBody — UI tests.
 *
 * Validates:
 *  - Cleartext (non-ratchet) bodies render directly.
 *  - Provided `cachedPlaintext` short-circuits decryption.
 *  - Missing Aegis copies keep a neutral recovery state, without ciphertext.
 *  - Real AES-GCM decryption updates the rendered text.
 *  - `forsure-decrypt-retry` retries the exact message when its copy arrives.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { useState } from 'react';

const mocks = vi.hoisted(() => ({ tryReadDeviceCopy: vi.fn() }));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'me' } } }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: { sender_id: 'peer' } }),
        }),
      }),
    }),
  },
}));
vi.mock('@/lib/crypto/plaintextStore', () => ({
  savePlaintext: vi.fn().mockResolvedValue(undefined),
  savePlaintextForCiphertext: vi.fn().mockResolvedValue(undefined),
  loadPlaintext: vi.fn().mockResolvedValue(null),
  loadPlaintextForCiphertext: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/messaging/multiDeviceFanout', () => ({
  tryReadDeviceCopy: mocks.tryReadDeviceCopy,
  clearDeviceCopyCache: vi.fn(),
  clearDeviceCopyCacheForMessage: vi.fn(),
}));
vi.mock('@/lib/crypto/peerKeyCache', () => ({
  getCachedAuthUserId: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/messaging/archive/archiveKey', () => ({
  decryptArchive: vi.fn().mockResolvedValue(null),
  recoverBubbleFromArchive: vi.fn().mockResolvedValue(null),
  archiveBubbleForUser: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/e2ee-session', () => ({
  routeIncoming: vi.fn().mockResolvedValue({ ok: false, plaintext: null }),
}));
vi.mock('@/components/chat/VoiceRecorder', () => ({
  VoiceMessagePlayer: () => null,
}));
vi.mock('@/lib/crypto/errorLogger', () => ({
  logCryptoError: vi.fn(),
  logCryptoException: vi.fn(),
}));

import { DecryptedMessageBody } from '@/components/messages/DecryptedMessageBody';
import { buildMediaMessageBody } from '@/lib/crypto/mediaEncrypt';
import { clearMediaKey, getMediaKey } from '@/components/messages/mediaKeyCache';
import { createAegisMessage } from '@/lib/messaging/aegisEnvelope';
import { clearDecryptionSessionCaches } from '@/components/messages/decryptionService';

const aegisContext = {
  messageId: '11111111-1111-4111-8111-111111111111',
  conversationId: '22222222-2222-4222-8222-222222222222',
  senderId: '33333333-3333-4333-8333-333333333333',
};

const UNSUPPORTED_ENCRYPTED_BODY = 'legacy.session.AAAA.0.0.IV.CT';

describe('DecryptedMessageBody', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearDecryptionSessionCaches();
    mocks.tryReadDeviceCopy.mockResolvedValue(null);
  });
  afterEach(() => clearDecryptionSessionCaches());

  it('renders cleartext directly when body is not encrypted', async () => {
    render(
      <DecryptedMessageBody
        body="hello world"
        decrypt={vi.fn()}
        isEncryptionActive={true}
      />,
    );
    expect(await screen.findByText('hello world')).toBeInTheDocument();
  });

  it('uses cachedPlaintext without calling decrypt', async () => {
    const decrypt = vi.fn();
    render(
      <DecryptedMessageBody
        body={UNSUPPORTED_ENCRYPTED_BODY}
        decrypt={decrypt}
        isEncryptionActive={true}
        cachedPlaintext="bonjour"
      />,
    );
    expect(await screen.findByText('bonjour')).toBeInTheDocument();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('does not republish identical cached plaintext when refreshKey changes', async () => {
    const onDecrypted = vi.fn();
    const decrypt = vi.fn();
    const props = {
      body: UNSUPPORTED_ENCRYPTED_BODY,
      decrypt,
      isEncryptionActive: true,
      cachedPlaintext: 'bonjour',
      messageId: 'msg-refresh-loop',
      onDecrypted,
    };
    const { rerender } = render(
      <DecryptedMessageBody {...props} refreshKey="cache:1" />,
    );

    expect(await screen.findByText('bonjour')).toBeInTheDocument();
    rerender(<DecryptedMessageBody {...props} refreshKey="cache:2" />);
    await act(async () => Promise.resolve());

    expect(decrypt).not.toHaveBeenCalled();
    expect(onDecrypted).not.toHaveBeenCalled();
  });

  it('publishes newly resolved plaintext once when the parent refreshes its cache', async () => {
    const published = vi.fn();

    function ParentCacheHarness() {
      const [cachedPlaintext, setCachedPlaintext] = useState<string>();
      const [refreshKey, setRefreshKey] = useState(0);
      return (
        <DecryptedMessageBody
          body="new plaintext"
          decrypt={vi.fn()}
          isEncryptionActive={false}
          cachedPlaintext={cachedPlaintext}
          refreshKey={refreshKey}
          messageId="msg-parent-cache-loop"
          onDecrypted={(text) => {
            published(text);
            setCachedPlaintext(text);
            setRefreshKey((value) => value + 1);
          }}
        />
      );
    }

    render(<ParentCacheHarness />);
    expect(await screen.findByText('new plaintext')).toBeInTheDocument();
    await waitFor(() => expect(published).toHaveBeenCalledTimes(1));
    await act(async () => Promise.resolve());
    expect(published).toHaveBeenCalledTimes(1);
  });

  it('normalizes cached media plaintext and never renders the embedded key', async () => {
    const messageId = 'msg-media-cache';
    const mediaKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const cachedPlaintext = buildMediaMessageBody('Photo', mediaKey);
    clearMediaKey(messageId);

    const { container } = render(
      <DecryptedMessageBody
        body={UNSUPPORTED_ENCRYPTED_BODY}
        decrypt={vi.fn()}
        isEncryptionActive={true}
        cachedPlaintext={cachedPlaintext}
        messageId={messageId}
        hasMedia={true}
      />,
    );

    await waitFor(() => expect(getMediaKey(messageId)?.mediaKeyB64).toBe(mediaKey));
    expect(container.textContent || '').not.toContain('MKEY:');
    expect(container.textContent || '').not.toContain(mediaKey);
  });

  it('renders cached GIF plaintext as media instead of raw text', async () => {
    render(
      <DecryptedMessageBody
        body={UNSUPPORTED_ENCRYPTED_BODY}
        decrypt={vi.fn()}
        isEncryptionActive={true}
        cachedPlaintext="GIF:https://example.com/a.gif"
      />,
    );

    expect(await screen.findByAltText('GIF')).toHaveAttribute('src', 'https://example.com/a.gif');
    expect(screen.queryByText(/GIF:https/)).not.toBeInTheDocument();
  });

  it('renders authenticated plaintext from a real Aegis envelope and device capsule', async () => {
    const created = await createAegisMessage({ ...aegisContext, plaintext: 'decrypted!' });
    mocks.tryReadDeviceCopy.mockResolvedValueOnce(created.keyCapsule);
    const decrypt = vi.fn();
    render(
      <DecryptedMessageBody
        body={created.body}
        decrypt={decrypt}
        isEncryptionActive={true}
        messageId={aegisContext.messageId}
        senderId={aegisContext.senderId}
      />,
    );
    expect(await screen.findByText('decrypted!')).toBeInTheDocument();
    expect(mocks.tryReadDeviceCopy).toHaveBeenCalledWith(
      aegisContext.messageId, aegisContext.senderId, { requestRetry: true },
    );
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('shows neutral recovery without leaking the ciphertext or secret after a device-copy miss', async () => {
    const created = await createAegisMessage({ ...aegisContext, plaintext: 'secret waiting for a capsule' });
    const decrypt = vi.fn();
    await act(async () => {
      render(<DecryptedMessageBody body={created.body} decrypt={decrypt} isEncryptionActive
        messageId={aegisContext.messageId} senderId={aegisContext.senderId} />);
    });
    expect(mocks.tryReadDeviceCopy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Message en cours de récupération…');
    expect(document.body.textContent).not.toContain('secret waiting for a capsule');
    expect(document.body.textContent).not.toContain(created.body);
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('retries the current Aegis copy after a targeted signal and renders its real plaintext', async () => {
    const created = await createAegisMessage({ ...aegisContext, plaintext: 'finally!' });
    mocks.tryReadDeviceCopy.mockResolvedValueOnce(null).mockResolvedValueOnce(created.keyCapsule);
    await act(async () => {
      render(<DecryptedMessageBody body={created.body} decrypt={vi.fn()} isEncryptionActive
        messageId={aegisContext.messageId} senderId={aegisContext.senderId} />);
    });
    expect(mocks.tryReadDeviceCopy).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
        detail: { messageId: aegisContext.messageId },
      }));
    });
    expect(await screen.findByText('finally!')).toBeInTheDocument();
    expect(mocks.tryReadDeviceCopy).toHaveBeenCalledTimes(2);
  });

  it('rejects another message capsule and recovers only after the exact authenticated capsule arrives', async () => {
    const created = await createAegisMessage({ ...aegisContext, plaintext: 'authenticated exact message' });
    const other = await createAegisMessage({ ...aegisContext,
      messageId: '44444444-4444-4444-8444-444444444444', plaintext: 'other private message',
    });
    mocks.tryReadDeviceCopy.mockResolvedValueOnce(other.keyCapsule).mockResolvedValueOnce(created.keyCapsule);
    await act(async () => {
      render(<DecryptedMessageBody body={created.body} decrypt={vi.fn()} isEncryptionActive
        messageId={aegisContext.messageId} senderId={aegisContext.senderId} />);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Message en cours de récupération…');
    expect(screen.queryByText('authenticated exact message')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('other private message');
    act(() => {
      window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
        detail: { messageId: aegisContext.messageId },
      }));
    });
    expect(await screen.findByText('authenticated exact message')).toBeInTheDocument();
    expect(mocks.tryReadDeviceCopy).toHaveBeenCalledTimes(2);
  });

  it('isMe self-message: tries plaintext store, stays silent if missing', async () => {
    const { container } = render(
      <DecryptedMessageBody
        body={UNSUPPORTED_ENCRYPTED_BODY}
        decrypt={vi.fn()}
        isEncryptionActive={true}
        isMe={true}
        messageId="msg-self"
      />,
    );
    // No placeholder ever rendered for our own messages
    await new Promise(r => setTimeout(r, 50));
    const text = container.textContent || '';
    expect(text).not.toMatch(/restauration|🔒|Message sécurisé/);
  });
});
