/**
 * MessageQueue — integration tests for iOS-hardened delivery flow.
 *
 * Validates the senior-engineer fixes:
 *  - Strict ciphertext detection (#7): plaintext that happens to start with `{`
 *    is no longer mistaken for a JSON envelope.
 *  - secure_wait retry: enqueueing without a registered handler keeps the
 *    message in `waiting_secure_channel`, never surfaces it as failed too early.
 *  - Plaintext is never persisted to IndexedDB (in-memory only).
 *  - reconcileDelivered marks already-acked messages as sent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@/lib/crypto/constants';

vi.mock('@/lib/crypto/errorLogger', () => ({
  logCryptoError: vi.fn(),
  logCryptoException: vi.fn(),
}));

import { messageQueue, type OutboundMessage } from '@/lib/messaging/messageQueue';

const CONV = 'conv-1';
const SENDER = 'user-1';

function strictJsonEnvelope(): string {
  return JSON.stringify({
    encryptionMode: 'ratchet',
    v: PROTOCOL_VERSION,
    kem: 'X25519',
    hdr: { dh: 'peer-dh', pn: 0, n: 1 },
    iv: 'iv',
    ct: 'ciphertext',
    sig: 'signature',
    fp: 'fingerprint',
    ts: Date.now(),
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise(r => setTimeout(r, 25));
  }
}

async function flushQueueDb(): Promise<void> {
  // Clear residual messages from previous tests. The queue exposes no purge,
  // so we mark everything sent via reconciliation noop; otherwise we leak
  // state across tests.
  const all = await messageQueue.getPendingMessages(CONV);
  for (const m of all) {
    await messageQueue.removeMessage(m.localId);
  }
}

describe('MessageQueue', () => {
  beforeEach(async () => {
    await flushQueueDb();
  });

  afterEach(async () => {
    await flushQueueDb();
  });

  it('rejects an "encrypted" output that is actually plaintext (strict prefix check)', async () => {
    // Handler returns the plaintext unchanged — should be flagged as a failed
    // encryption and bounce back to waiting_secure_channel, NOT marked as sent.
    const sendCalled = vi.fn();
    messageQueue.registerHandlers(CONV, 'h1', {
      encrypt: async (pt: string) => pt, // BUG: returns plaintext
      send: async (m: OutboundMessage) => { sendCalled(m); return 'srv-id'; },
      isReady: () => true,
    });

    await messageQueue.enqueue({ conversationId: CONV, senderId: SENDER, plaintext: 'plain text' });
    await waitFor(async () => {
      const pending = await messageQueue.getPendingMessages(CONV);
      return pending.some(m => m.status === 'waiting_secure_channel');
    });
    expect(sendCalled).not.toHaveBeenCalled();

    messageQueue.unregisterHandlers(CONV, 'h1');
  });

  it('rejects "ciphertext" that does not match a known outbound protocol shape', async () => {
    // Plaintext containing JSON-looking text must NOT slip through under the
    // old `startsWith("{")` heuristic. The new strict check requires the
    // output to differ from the plaintext AND start with a known prefix.
    messageQueue.registerHandlers(CONV, 'h2', {
      encrypt: async () => 'totally not ciphertext',
      send: async () => 'srv-id',
      isReady: () => true,
    });

    await messageQueue.enqueue({ conversationId: CONV, senderId: SENDER, plaintext: 'hi' });
    await waitFor(async () => {
      const pending = await messageQueue.getPendingMessages(CONV);
      return pending.some(m => m.status === 'waiting_secure_channel');
    });
    messageQueue.unregisterHandlers(CONV, 'h2');
  });

  it('rejects arbitrary JSON from encrypt before any send attempt', async () => {
    const sent = vi.fn().mockResolvedValue('srv-json');
    messageQueue.registerHandlers(CONV, 'h-json-invalid', {
      encrypt: async () => '{"hello":"not crypto"}',
      send: async (m) => sent(m),
      isReady: () => true,
    });

    const msg = await messageQueue.enqueue({ conversationId: CONV, senderId: SENDER, plaintext: 'hi' });
    await waitFor(async () => {
      const pending = await messageQueue.getPendingMessages(CONV);
      return pending.some(m => m.localId === msg.localId && m.status === 'waiting_secure_channel');
    });

    expect(sent).not.toHaveBeenCalled();
    await messageQueue.removeMessage(msg.localId);
    messageQueue.unregisterHandlers(CONV, 'h-json-invalid');
  });

  it('accepts a JSON envelope (conv-level ratchet) as valid ciphertext', async () => {
    const sent = vi.fn().mockResolvedValue('srv-200');
    messageQueue.registerHandlers(CONV, 'h3', {
      encrypt: async () => strictJsonEnvelope(),
      send: async (m) => sent(m),
      isReady: () => true,
    });

    await messageQueue.enqueue({ conversationId: CONV, senderId: SENDER, plaintext: 'hello' });
    await waitFor(() => sent.mock.calls.length > 0);

    const sentMsg = sent.mock.calls[0][0] as OutboundMessage;
    expect(sentMsg.encryptedBody).toBeTruthy();
    expect(sentMsg.encryptedBody!.startsWith('{')).toBe(true);
    messageQueue.unregisterHandlers(CONV, 'h3');
  });

  it('does not send when encryption reports a contact key mismatch', async () => {
    const sent = vi.fn().mockResolvedValue('srv-blocked');
    messageQueue.registerHandlers(CONV, 'h-key-blocked', {
      encrypt: async () => {
        throw new Error('Cle de securite du contact modifiee - verification obligatoire avant envoi');
      },
      send: async (m) => sent(m),
      isReady: () => true,
    });

    const msg = await messageQueue.enqueue({ conversationId: CONV, senderId: SENDER, plaintext: 'blocked' });
    await waitFor(async () => {
      const pending = await messageQueue.getPendingMessages(CONV);
      return pending.some(m =>
        m.localId === msg.localId &&
        m.status === 'failed_visible' &&
        m.lastError === 'secure_channel_blocked'
      );
    });

    expect(sent).not.toHaveBeenCalled();
    await messageQueue.removeMessage(msg.localId);
    messageQueue.unregisterHandlers(CONV, 'h-key-blocked');
  });

  it('accepts a v4 device ratchet envelope (x3dh4. prefix)', async () => {
    const sent = vi.fn().mockResolvedValue('srv-201');
    messageQueue.registerHandlers(CONV, 'h4', {
      encrypt: async () => 'x3dh4.sess-1.AAAA.0.0.IV.CT',
      send: async (m) => sent(m),
      isReady: () => true,
    });

    await messageQueue.enqueue({ conversationId: CONV, senderId: SENDER, plaintext: 'ratchet' });
    await waitFor(() => sent.mock.calls.length > 0);
    expect(sent.mock.calls[0][0].encryptedBody).toMatch(/^x3dh4\./);
    messageQueue.unregisterHandlers(CONV, 'h4');
  });

  it('keeps message in waiting_secure_channel when no handler is ready (iOS cold start)', async () => {
    messageQueue.registerHandlers(CONV, 'h5', {
      encrypt: async () => '{"ct":"x"}',
      send: async () => 'srv',
      isReady: () => false, // never ready
    });

    const m = await messageQueue.enqueue({
      conversationId: CONV, senderId: SENDER, plaintext: 'queued',
    });
    await waitFor(async () => {
      const cur = await messageQueue.getPendingMessages(CONV);
      return cur.some(p => p.localId === m.localId && p.status === 'waiting_secure_channel');
    });

    const pending = await messageQueue.getPendingMessages(CONV);
    const ours = pending.find(p => p.localId === m.localId)!;
    expect(ours.status).toBe('waiting_secure_channel');
    expect(ours.serverId).toBeNull();
    messageQueue.unregisterHandlers(CONV, 'h5');
  });

  it('does not persist plaintext to IndexedDB (in-memory only)', async () => {
    messageQueue.registerHandlers(CONV, 'h6', {
      encrypt: async () => strictJsonEnvelope(),
      send: async () => 'srv-300',
      isReady: () => true,
    });

    const sent = vi.fn();
    const unsub = messageQueue.subscribe((msgs) => {
      msgs.forEach(m => sent(m));
    });

    const enq = await messageQueue.enqueue({
      conversationId: CONV, senderId: SENDER, plaintext: 'super-secret-value',
    });

    // Read raw IndexedDB row directly — `plaintext` field MUST be empty string.
    const raw = await new Promise<any>((resolve, reject) => {
      const req = indexedDB.open('forsure-msg-queue', 1);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('outbound')) { resolve(null); return; }
        const tx = db.transaction('outbound', 'readonly');
        const r = tx.objectStore('outbound').get(enq.localId);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      };
      req.onerror = () => reject(req.error);
    });

    if (raw) {
      expect(raw.plaintext).toBe('');
    }

    unsub();
    messageQueue.unregisterHandlers(CONV, 'h6');
  });

  it('reconcileDelivered marks queued messages as sent when backend already accepted them', async () => {
    messageQueue.registerHandlers(CONV, 'h7', {
      encrypt: async () => strictJsonEnvelope(),
      send: async () => { throw new Error('network error'); }, // simulate ack lost
      isReady: () => true,
    });

    const m = await messageQueue.enqueue({
      conversationId: CONV, senderId: SENDER, plaintext: 'reconcile me',
    });

    // Wait until the message has been encrypted at least once
    await waitFor(async () => {
      const cur = await messageQueue.getPendingMessages(CONV);
      const found = cur.find(p => p.localId === m.localId);
      return !!found && (!!found.encryptedBody || found.status === 'retry_pending');
    });

    const encryptedBody = (await messageQueue.getPendingMessages(CONV))
      .find(p => p.localId === m.localId)?.encryptedBody;
    expect(encryptedBody).toBeTruthy();

    // Simulate backend already received this exact encrypted body
    await messageQueue.reconcileDelivered(CONV, [
      {
        id: 'srv-real',
        senderId: SENDER,
        body: encryptedBody!,
        createdAt: new Date(m.createdAt + 1000).toISOString(),
      },
    ]);

    const finalPending = await messageQueue.getPendingMessages(CONV);
    expect(finalPending.find(p => p.localId === m.localId)).toBeUndefined();
    messageQueue.unregisterHandlers(CONV, 'h7');
  });
});
