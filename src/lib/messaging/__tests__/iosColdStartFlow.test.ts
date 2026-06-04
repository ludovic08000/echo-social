/**
 * iOS cold-start integration scenario — full lifecycle.
 *
 * Goal: prove the messaging stack survives the realistic iOS PWA pattern:
 *   1. User taps "send" while the secure channel is still bootstrapping
 *      (X3DH bundle fetch + Double Ratchet rehydration) → message lands in
 *      `waiting_secure_channel`, NEVER as `failed_visible`, NEVER sent in
 *      plaintext.
 *   2. App is backgrounded / handler unmounts (tab switch, screen lock).
 *   3. App is foregrounded → handlers re-register, secure channel becomes
 *      ready → `resumeForConversation` drains the backlog → every queued
 *      message is encrypted and sent in original order, exactly once.
 *   4. A "true cold-start" branch (volatile plaintext wiped) surfaces the
 *      message as `failed_visible` with the canonical "Message perdu" error
 *      instead of silently dropping it.
 *   5. The send retry path (transient network failure) eventually succeeds
 *      without duplicating the server insert.
 *
 * Critical invariants asserted throughout:
 *   - No `send()` is ever invoked with plaintext.
 *   - No `send()` is invoked while `isReady === false`.
 *   - IndexedDB rows never carry plaintext (always empty string).
 *   - Each enqueued message produces AT MOST one successful `send()`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/crypto/errorLogger', () => ({
  logCryptoError: vi.fn(),
  logCryptoException: vi.fn(),
}));

import { messageQueue, type OutboundMessage } from '@/lib/messaging/messageQueue';

const CONV = 'conv-cold-start';
const SENDER = 'user-ios';

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (true) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function purgeAllForConv(): Promise<void> {
  const all = await messageQueue.getPendingMessages(CONV);
  for (const m of all) await messageQueue.removeMessage(m.localId);
}

/** Read raw IndexedDB row to assert plaintext is never on disk. */
async function readRawRow(localId: string): Promise<any | null> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('forsure-msg-queue', 1);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('outbound')) {
        resolve(null);
        return;
      }
      const tx = db.transaction('outbound', 'readonly');
      const r = tx.objectStore('outbound').get(localId);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Mutable handler state — lets a test toggle `isReady` and swap the encrypt
 * impl mid-flight to simulate the channel going from "bootstrapping" to
 * "ready", then to "transient send error", then to "OK".
 */
interface FakeChannel {
  ready: boolean;
  encrypt: (pt: string) => Promise<string>;
  send: (m: OutboundMessage) => Promise<string>;
  sentBodies: string[];
  sentLocalIds: string[];
}

function makeChannel(initial: Partial<FakeChannel> = {}): FakeChannel {
  const ch: FakeChannel = {
    ready: initial.ready ?? false,
    encrypt:
      initial.encrypt ??
      (async (pt: string) => `x3dh5.sess.AAAA.0.0.IV.${btoa(unescape(encodeURIComponent(pt)))}`),
    send: initial.send ?? (async () => `srv-${Math.random().toString(36).slice(2, 8)}`),
    sentBodies: [],
    sentLocalIds: [],
  };
  return ch;
}

function registerChannel(ch: FakeChannel, handlerId = 'h-default') {
  messageQueue.registerHandlers(CONV, handlerId, {
    encrypt: async (pt, _conv, _localId) => {
      const out = await ch.encrypt(pt);
      // SECURITY ASSERT: never return plaintext.
      if (out === pt) throw new Error('test bug: encrypt returned plaintext');
      return out;
    },
    send: async (m) => {
      // SECURITY ASSERTS — these are the production invariants we never want
      // to regress. Failing here means the queue would have leaked plaintext
      // or sent before the channel was secure.
      if (!ch.ready) throw new Error('INVARIANT: send() called while channel not ready');
      if (!m.encryptedBody || !m.encryptedBody.startsWith('x3dh5.')) {
        throw new Error('INVARIANT: send() called without v5 ciphertext');
      }
      const id = await ch.send(m);
      ch.sentBodies.push(m.encryptedBody);
      ch.sentLocalIds.push(m.localId);
      return id;
    },
    isReady: () => ch.ready,
  });
  return () => messageQueue.unregisterHandlers(CONV, handlerId);
}

describe('iOS cold-start — secure channel rehydration', () => {
  beforeEach(async () => {
    await purgeAllForConv();
  });
  afterEach(async () => {
    await purgeAllForConv();
  });

  it('enqueues 3 messages while channel is down, then drains them in order after rehydration', async () => {
    // Phase 1 — channel cold. Handler is registered but `isReady === false`.
    const ch = makeChannel({ ready: false });
    const unreg = registerChannel(ch);

    const m1 = await messageQueue.enqueue({ conversationId: CONV, senderId: SENDER, plaintext: 'hello-1' });
    const m2 = await messageQueue.enqueue({ conversationId: CONV, senderId: SENDER, plaintext: 'hello-2' });
    const m3 = await messageQueue.enqueue({ conversationId: CONV, senderId: SENDER, plaintext: 'hello-3' });

    // At least one (the one being processed) must land in waiting_secure_channel.
    // The others stay in pending_local until the active retry timer fires
    // (queue serializes per-conversation processing).
    await waitFor(async () => {
      const pending = await messageQueue.getPendingMessages(CONV);
      const ids = new Set([m1.localId, m2.localId, m3.localId]);
      const ours = pending.filter((p) => ids.has(p.localId));
      return ours.length === 3 && ours.some((p) => p.status === 'waiting_secure_channel');
    });
    expect(ch.sentBodies).toHaveLength(0);

    // Plaintext must NOT be on disk for any of the three.
    for (const lid of [m1.localId, m2.localId, m3.localId]) {
      const raw = await readRawRow(lid);
      if (raw) expect(raw.plaintext).toBe('');
    }

    // Phase 2 — secure channel becomes ready (X3DH bootstrap finished).
    ch.ready = true;

    // The 3 messages will drain as their secure_wait timers (3s each) fire
    // serially. Worst case: 3 × 3s = 9s. Allow a healthy margin.
    await waitFor(() => ch.sentBodies.length === 3, 20_000);
    expect(ch.sentLocalIds).toEqual([m1.localId, m2.localId, m3.localId]);
    expect(new Set(ch.sentBodies).size).toBe(3);

    await waitFor(async () => (await messageQueue.getPendingMessages(CONV)).length === 0, 5_000);
    unreg();
  }, 30_000);

  it('handler unmount + remount preserves the queue and resumes cleanly', async () => {
    // Cold channel.
    const ch1 = makeChannel({ ready: false });
    const unreg1 = registerChannel(ch1, 'h-cold');

    const m = await messageQueue.enqueue({
      conversationId: CONV,
      senderId: SENDER,
      plaintext: 'survives-unmount',
    });
    await waitFor(async () => {
      const p = await messageQueue.getPendingMessages(CONV);
      return p.some((x) => x.localId === m.localId && x.status === 'waiting_secure_channel');
    });

    // Tab backgrounded → ChatView unmounts → handler unregistered.
    unreg1();

    // App foregrounded → fresh ChatView mounts → ready handler registers.
    const ch2 = makeChannel({ ready: true });
    const unreg2 = registerChannel(ch2, 'h-ready');

    // The pending message has an active secure_wait timer (3s). The next
    // tick will see the ready handler and successfully encrypt + send.
    await waitFor(() => ch2.sentBodies.length === 1, 15_000);
    expect(ch2.sentLocalIds).toEqual([m.localId]);
    // Old (cold) handler must not have been invoked at all.
    expect(ch1.sentBodies).toHaveLength(0);

    unreg2();
  }, 25_000);
});

describe('iOS cold-start — true volatile-memory loss', () => {
  beforeEach(async () => {
    await purgeAllForConv();
  });
  afterEach(async () => {
    await purgeAllForConv();
  });

  it('marks message as failed_visible with "Message perdu" when plaintext is gone post-restart', async () => {
    // Step 1: handler comes online ready → encrypt step starts immediately.
    const ch = makeChannel({ ready: true });
    const unreg = registerChannel(ch);

    const m = await messageQueue.enqueue({
      conversationId: CONV,
      senderId: SENDER,
      plaintext: 'will-be-lost',
    });

    // Step 2: simulate cold-start happening BEFORE encryption pulls the
    // plaintext — wipe the volatile map. The internal Map is private; the
    // public surface that loses it is the page reload itself. We emulate
    // that by reaching into the singleton.
    const internal = messageQueue as unknown as { volatilePlaintext: Map<string, string> };
    internal.volatilePlaintext.delete(m.localId);

    // Step 3: encrypt step runs, finds no plaintext → must surface as
    // failed_visible with the canonical user-facing message (NOT silent
    // drop, NOT plaintext leak).
    await waitFor(async () => {
      const p = await messageQueue.getPendingMessages(CONV);
      const ours = p.find((x) => x.localId === m.localId);
      return ours?.status === 'failed_visible';
    }, 10_000);

    const final = (await messageQueue.getPendingMessages(CONV)).find(
      (x) => x.localId === m.localId,
    )!;
    expect(final.status).toBe('failed_visible');
    expect(final.lastError).toMatch(/Message perdu/i);
    expect(ch.sentBodies).toHaveLength(0);

    unreg();
  }, 15_000);
});

describe('iOS cold-start — send retry without duplication', () => {
  beforeEach(async () => {
    await purgeAllForConv();
  });
  afterEach(async () => {
    await purgeAllForConv();
  });

  it('retries after a transient send failure and never produces a duplicate server insert', async () => {
    let sendAttempts = 0;
    const ch = makeChannel({
      ready: true,
      send: async () => {
        sendAttempts += 1;
        if (sendAttempts === 1) throw new Error('Network unreachable (transient)');
        return `srv-final-${sendAttempts}`;
      },
    });
    const unreg = registerChannel(ch);

    const m = await messageQueue.enqueue({
      conversationId: CONV,
      senderId: SENDER,
      plaintext: 'retry-me',
    });

    // Wait for the eventual successful send.
    await waitFor(() => ch.sentBodies.length === 1, 8000);
    expect(sendAttempts).toBeGreaterThanOrEqual(2); // at least one failure + one success
    expect(ch.sentLocalIds).toEqual([m.localId]);

    // Queue empties after success — no leftover ghost retry.
    await waitFor(async () => (await messageQueue.getPendingMessages(CONV)).length === 0, 6000);

    unreg();
  });

  it('reconcileDelivered after a lost ack does not double-send when the channel comes back', async () => {
    // Simulate: send actually reached backend but the ack never came back.
    const ch = makeChannel({
      ready: true,
      send: async () => {
        throw new Error('Ack lost');
      },
    });
    const unreg = registerChannel(ch);

    const m = await messageQueue.enqueue({
      conversationId: CONV,
      senderId: SENDER,
      plaintext: 'recon-cold',
    });

    // Wait until we have a ciphertext on the message (encrypt succeeded).
    await waitFor(async () => {
      const p = await messageQueue.getPendingMessages(CONV);
      const ours = p.find((x) => x.localId === m.localId);
      return !!ours?.encryptedBody;
    });

    const cipher = (await messageQueue.getPendingMessages(CONV)).find(
      (x) => x.localId === m.localId,
    )!.encryptedBody!;

    // Backend confirms the message exists with that exact ciphertext.
    await messageQueue.reconcileDelivered(CONV, [
      {
        id: 'srv-reconciled',
        senderId: SENDER,
        body: cipher,
        createdAt: new Date(m.createdAt + 500).toISOString(),
      },
    ]);

    // Message must be cleared from the queue without ever invoking a
    // successful send (the only send attempts threw).
    await waitFor(async () => {
      const p = await messageQueue.getPendingMessages(CONV);
      return !p.find((x) => x.localId === m.localId);
    }, 6000);
    expect(ch.sentBodies).toHaveLength(0);

    unreg();
  });
});
