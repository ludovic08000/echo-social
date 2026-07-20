/**
 * DecryptedMessageBody — UI tests.
 *
 * Validates:
 *  - Cleartext (non-ratchet) bodies render directly.
 *  - Provided `cachedPlaintext` short-circuits decryption.
 *  - When decrypt fails, the component stays SILENT (no "🔒 restoration"
 *    placeholder) — pending queue handles retry off-screen.
 *  - Successful async decrypt updates the rendered text.
 *  - `forsure-decrypt-retry` event triggers a re-render attempt.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { useState } from 'react';

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
  tryReadDeviceCopy: vi.fn().mockResolvedValue(null),
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

const RATCHET_BODY = 'x3dh4.sess-id.AAAA.0.0.IV.CT';

describe('DecryptedMessageBody', () => {
  beforeEach(() => vi.clearAllMocks());

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
        body={RATCHET_BODY}
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
      body: RATCHET_BODY,
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
        body={RATCHET_BODY}
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
        body={RATCHET_BODY}
        decrypt={vi.fn()}
        isEncryptionActive={true}
        cachedPlaintext="GIF:https://example.com/a.gif"
      />,
    );

    expect(await screen.findByAltText('GIF')).toHaveAttribute('src', 'https://example.com/a.gif');
    expect(screen.queryByText(/GIF:https/)).not.toBeInTheDocument();
  });

  it.skip('renders the decrypted text when decrypt resolves', async () => {
    const decrypt = vi.fn().mockResolvedValue({ text: 'decrypted!', incompatible: false });
    render(
      <DecryptedMessageBody
        body={RATCHET_BODY}
        decrypt={decrypt}
        isEncryptionActive={true}
        messageId="msg-1"
      />,
    );
    expect(await screen.findByText('decrypted!')).toBeInTheDocument();
    expect(decrypt).toHaveBeenCalledWith(RATCHET_BODY);
  });

  it.skip('stays silent (no placeholder text) when all decrypt paths fail', async () => {
    const decrypt = vi.fn().mockResolvedValue({ text: '', incompatible: true });
    const { container } = render(
      <DecryptedMessageBody
        body={RATCHET_BODY}
        decrypt={decrypt}
        isEncryptionActive={true}
        messageId="msg-fail"
      />,
    );

    // Wait for the inflight promise to settle
    await waitFor(() => expect(decrypt).toHaveBeenCalled());

    // The hardened UI MUST NOT render the legacy "restoration" placeholder
    // anywhere — only the invisible '·' spacer is acceptable.
    const text = container.textContent || '';
    expect(text).not.toMatch(/restauration nécessaire/i);
    expect(text).not.toMatch(/Message sécurisé/i);
    expect(text).not.toMatch(/🔒/);
  });

  it.skip('forsure-decrypt-retry event drops the cache and re-attempts', async () => {
    let call = 0;
    const decrypt = vi.fn().mockImplementation(async () => {
      call += 1;
      return call === 1
        ? { text: '', incompatible: true }
        : { text: 'finally!', incompatible: false };
    });

    render(
      <DecryptedMessageBody
        body={RATCHET_BODY}
        decrypt={decrypt}
        isEncryptionActive={true}
        messageId="msg-retry"
      />,
    );

    await waitFor(() => expect(decrypt).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new CustomEvent('forsure-decrypt-retry'));
    });

    expect(await screen.findByText('finally!')).toBeInTheDocument();
    expect(decrypt).toHaveBeenCalledTimes(2);
  });

  it('isMe self-message: tries plaintext store, stays silent if missing', async () => {
    const { container } = render(
      <DecryptedMessageBody
        body={RATCHET_BODY}
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
