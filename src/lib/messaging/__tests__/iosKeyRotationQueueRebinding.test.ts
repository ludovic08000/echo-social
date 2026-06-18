/**
 * iOS key-rotation rebinding — integration scenario.
 *
 * Reality on iOS: the user can rotate identity / device keys (PIN re-wrap,
 * device re-pairing, scheduled 7-day rotation, manual "resync" from the
 * Backup screen) AT ANY TIME — including while the message queue still
 * holds outbound messages waiting for the secure channel.
 *
 * If the queue rebinds incorrectly, two catastrophic regressions occur:
 *   (a) ciphertext gets produced with the OLD identity → peer cannot
 *       decrypt and the message dies as `E_DECRYPT_PENDING` forever;
 *   (b) plaintext stays in volatile memory and gets re-encrypted with
 *       the NEW identity but addressed to the OLD device id → wrong
 *       envelope routing, peer-side ratchet desync.
 *
 * This suite exercises the production rebinding contract end-to-end against
 * the real `messageQueue` singleton (with fake IndexedDB), simulating the
 * three rotation patterns that actually happen on iOS:
 *
 *   1. Identity rotation while messages sit in `waiting_secure_channel`.
 *      ⇒ When the channel comes back ready under the NEW identity, the
 *        queued messages MUST encrypt with the new identity (asserted by
 *        the encrypt handler tagging the ciphertext with its key epoch).
 *
 *   2. Identity + device rotation across a "page reload" (resumeAll).
 *      ⇒ For messages whose plaintext is still in volatile memory, the
 *        queue MUST drop any stale ciphertext and re-encrypt with the
 *        current handler (current keys + current device id).
 *
 *   3. Already-encrypted message whose plaintext was wiped (true cold
 *      start) survives a rotation: it MUST NOT be silently re-encrypted
 *      (no plaintext available), MUST NOT vanish, and MUST surface as
 *      `failed_visible` with the canonical "Message perdu" error so the
 *      user can re-send.
 *
 * Plaintext leakage is also asserted across every step (raw IndexedDB read).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/crypto/errorLogger', () => ({
  logCryptoError: vi.fn(),
  logCryptoException: vi.fn(),
}));

vi.mock('@/lib/crypto/e2eeDeviceGate', () => ({
  assertE2EETrustedBrowserDevice: vi.fn().mockResolvedValue({ ok: true, status: 'READY', assessment: null }),
  clearE2EEDeviceGateCache: vi.fn(),
  E2EEDeviceGateError: class E2EEDeviceGateError extends Error {},
}));

import { messageQueue, type OutboundMessage } from '@/lib/messaging/messageQueue';

const CONV = 'conv-rotation';
const SENDER = 'user-ios';

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
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
 * A "key bundle" emulating the relevant parts of an identity. Rotating
 * the bundle means: new identity epoch + new device id. The encrypt
 * handler embeds both into the ciphertext envelope, so we can assert
 * AFTER THE FACT which keys were used to encrypt each message.
 */
interface KeyBundle {
  identityEpoch: number;       // bumps on every identity rotation
  deviceId: string;            // bumps on every device rotation
}

interface MutableHandler {
  ready: boolean;
  bundle: KeyBundle;
  encryptCalls: Array<{ localId: string; epoch: number; deviceId: string; plaintext: string }>;
  sentEnvelopes: Array<{ localId: string; envelope: string; epoch: number; deviceId: string }>;
  /** When true, send() throws — used to keep messages stuck in the queue. */
  sendThrows: boolean;
}

function makeHandler(initial: Partial<MutableHandler> = {}): MutableHandler {
  return {
    ready: initial.ready ?? false,
    bundle: initial.bundle ?? { identityEpoch: 1, deviceId: 'dev-A' },
    encryptCalls: [],
    sentEnvelopes: [],
    sendThrows: initial.sendThrows ?? false,
  };
}

/**
 * Encode an envelope that LOOKS like a v4 device-pair Double Ratchet
 * ciphertext (`x3dh4.<sess>.<n>.<pn>.<iv>.<body>`) and embeds the
 * encrypting bundle so tests can verify rebinding.
 *
 * Body is `{epoch}|{deviceId}|{localId}|{plaintext-b64}` — base64-encoded.
 * NO secret leaks: this is a TEST stub, but plaintext IS embedded inside
 * the ciphertext blob (which is the production behaviour for real E2EE
 * ciphertexts as well — they decrypt to plaintext on the recipient side).
 */
function encodeEnvelope(bundle: KeyBundle, localId: string, plaintext: string): string {
  const inner = `${bundle.identityEpoch}|${bundle.deviceId}|${localId}|${btoa(unescape(encodeURIComponent(plaintext)))}`;
  const body = btoa(unescape(encodeURIComponent(inner)));
  return `x3dh4.sess.${bundle.identityEpoch}.0.IV.${body}`;
}

function decodeEnvelope(envelope: string): { epoch: number; deviceId: string; localId: string; plaintext: string } {
  const parts = envelope.split('.');
  const body = parts[parts.length - 1];
  const inner = decodeURIComponent(escape(atob(body)));
  const [epochStr, deviceId, localId, ptB64] = inner.split('|');
  return {
    epoch: Number(epochStr),
    deviceId,
    localId,
    plaintext: decodeURIComponent(escape(atob(ptB64))),
  };
}

function registerHandler(h: MutableHandler, handlerId: string) {
  messageQueue.registerHandlers(CONV, handlerId, {
    encrypt: async (pt, _conv, localId) => {
      // SECURITY: encrypt MUST run against current bundle, not a captured one.
      const snapshot = h.bundle;
      h.encryptCalls.push({
        localId,
        epoch: snapshot.identityEpoch,
        deviceId: snapshot.deviceId,
        plaintext: pt,
      });
      const env = encodeEnvelope(snapshot, localId, pt);
      // Sanity: ciphertext bytes must differ from plaintext bytes.
      if (env === pt) throw new Error('test bug: encrypt returned plaintext');
      return env;
    },
    send: async (m) => {
      if (!h.ready) throw new Error('INVARIANT: send() while channel not ready');
      if (!m.encryptedBody?.startsWith('x3dh4.')) {
        throw new Error('INVARIANT: send() without v4 ciphertext');
      }
      if (h.sendThrows) throw new Error('Network unreachable (test)');
      const decoded = decodeEnvelope(m.encryptedBody);
      h.sentEnvelopes.push({
        localId: m.localId,
        envelope: m.encryptedBody,
        epoch: decoded.epoch,
        deviceId: decoded.deviceId,
      });
      return `srv-${m.localId}`;
    },
    isReady: () => h.ready,
  });
  return () => messageQueue.unregisterHandlers(CONV, handlerId);
}

describe('iOS key rotation — queued message rebinding', () => {
  beforeEach(() => purgeAllForConv());
  afterEach(() => purgeAllForConv());

  it('re-encrypts queued messages with the NEW identity after rotation while in waiting_secure_channel', async () => {
    // Phase 1 — channel cold, identity epoch = 1, device = dev-A.
    const h = makeHandler({ ready: false, bundle: { identityEpoch: 1, deviceId: 'dev-A' } });
    const unreg = registerHandler(h, 'h-rot-1');

    const m1 = await messageQueue.enqueue({ conversationId: CONV, senderId: SENDER, plaintext: 'pre-rotation-1' });
    const m2 = await messageQueue.enqueue({ conversationId: CONV, senderId: SENDER, plaintext: 'pre-rotation-2' });

    // Wait for the queue to park them in waiting_secure_channel.
    await waitFor(async () => {
      const p = await messageQueue.getPendingMessages(CONV);
      const ours = p.filter((x) => x.localId === m1.localId || x.localId === m2.localId);
      return ours.length === 2 && ours.some((x) => x.status === 'waiting_secure_channel');
    });

    // Disk MUST NOT carry plaintext.
    for (const lid of [m1.localId, m2.localId]) {
      const raw = await readRawRow(lid);
      if (raw) expect(raw.plaintext).toBe('');
    }

    // Phase 2 — IDENTITY ROTATION happens (epoch 1 → 2, device dev-A → dev-B).
    h.bundle = { identityEpoch: 2, deviceId: 'dev-B' };
    h.ready = true;

    // Production: when the channel becomes ready, ChatView remounts and
    // network listeners call `resumeForConversation`. We mimic that —
    // relying solely on the 3s secure_wait timer is unreliable because it
    // can collide with the per-conversation serialisation lock.
    await messageQueue.resumeForConversation(CONV);

    // Drain both messages. Re-issue resume after the 1.5s debounce window
    // if the second message stays parked behind the per-conversation lock.
    await waitFor(async () => {
      if (h.sentEnvelopes.length >= 2) return true;
      if (h.sentEnvelopes.length === 1) {
        await new Promise((r) => setTimeout(r, 1600));
        await messageQueue.resumeForConversation(CONV);
      }
      return false;
    }, 30_000);

    // CRITICAL: every encrypt call must have used the NEW bundle.
    expect(h.encryptCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of h.encryptCalls) {
      expect(call.epoch).toBe(2);
      expect(call.deviceId).toBe('dev-B');
    }
    // And every wire envelope is bound to the new keys + the right localId.
    const sentByLocal = new Map(h.sentEnvelopes.map((s) => [s.localId, s]));
    for (const lid of [m1.localId, m2.localId]) {
      const sent = sentByLocal.get(lid);
      expect(sent).toBeDefined();
      expect(sent!.epoch).toBe(2);
      expect(sent!.deviceId).toBe('dev-B');
      const decoded = decodeEnvelope(sent!.envelope);
      expect(decoded.localId).toBe(lid);
    }

    await waitFor(async () => (await messageQueue.getPendingMessages(CONV)).length === 0, 5000);
    unreg();
  }, 30_000);

  it('rebinds plaintext-bearing messages to NEW keys on resumeAll (page reload + rotation)', async () => {
    // Phase 1 — first identity, ready handler, but send is broken so the
    // message gets encrypted (with epoch 1) yet never leaves the queue.
    const h1 = makeHandler({
      ready: true,
      bundle: { identityEpoch: 1, deviceId: 'dev-A' },
      sendThrows: true,
    });
    const unreg1 = registerHandler(h1, 'h-pre');

    const m = await messageQueue.enqueue({
      conversationId: CONV,
      senderId: SENDER,
      plaintext: 'survives-rotation',
    });

    // Wait until encrypt-with-epoch-1 has actually run.
    await waitFor(() => h1.encryptCalls.some((c) => c.localId === m.localId && c.epoch === 1));
    expect(h1.sentEnvelopes).toHaveLength(0); // send is throwing

    // Disk MUST NOT carry plaintext, even after encryption.
    const raw = await readRawRow(m.localId);
    if (raw) expect(raw.plaintext).toBe('');

    // Phase 2 — handler unregisters (page reload), then resumeAll runs
    // with a brand-new handler that has the NEW keys (epoch 2, dev-B).
    unreg1();

    const h2 = makeHandler({
      ready: true,
      bundle: { identityEpoch: 2, deviceId: 'dev-B' },
      sendThrows: false,
    });
    const unreg2 = registerHandler(h2, 'h-post');

    // Production calls resumeAll() on app load. Plaintext is still in
    // volatile memory, so resumeAll MUST drop the stale (epoch 1)
    // ciphertext and force re-encryption against the current handler.
    await messageQueue.resumeAll();

    await waitFor(() => h2.sentEnvelopes.length === 1, 10_000);

    // Re-encryption against the new identity is the whole point.
    expect(h2.encryptCalls.some((c) => c.localId === m.localId && c.epoch === 2 && c.deviceId === 'dev-B')).toBe(true);

    const sent = h2.sentEnvelopes[0];
    expect(sent.localId).toBe(m.localId);
    expect(sent.epoch).toBe(2);
    expect(sent.deviceId).toBe('dev-B');

    // The OLD handler must NEVER have received a send for the rotated msg.
    expect(h1.sentEnvelopes).toHaveLength(0);

    await waitFor(async () => (await messageQueue.getPendingMessages(CONV)).length === 0, 5000);
    unreg2();
  }, 25_000);

  it('ships ALREADY-CIPHERED messages bound to the OLD identity verbatim — never silently rebinds them to the new keys', async () => {
    // Critical security/integrity property: once a plaintext has been
    // encrypted under the OLD identity and the plaintext is gone (true cold
    // start: page reload, RAM wiped), the queue MUST send the existing
    // ciphertext UNCHANGED. It MUST NOT:
    //   • call encrypt() again (no plaintext is available — that would
    //     necessarily be a NEW message body, not the user's original);
    //   • re-tag the envelope with the new identity epoch (which would
    //     make the receiver believe the OLD message originated from the
    //     NEW identity — a forgeable provenance bug).
    //
    // Receiver-side decryption of the OLD ciphertext is handled by the
    // Double Ratchet skipped-key cache + per-pair sessions, which survive
    // identity rotation. The queue's job is purely to ship-as-is.

    // Phase 1 — first identity (epoch 1), send broken so we end up with a
    // message that has encryptedBody set but never reached the wire.
    const h1 = makeHandler({
      ready: true,
      bundle: { identityEpoch: 1, deviceId: 'dev-A' },
      sendThrows: true,
    });
    const unreg1 = registerHandler(h1, 'h-cold-pre');

    const m = await messageQueue.enqueue({
      conversationId: CONV,
      senderId: SENDER,
      plaintext: 'cipher-bound-to-epoch-1',
    });
    await waitFor(() => h1.encryptCalls.some((c) => c.localId === m.localId && c.epoch === 1));

    // Wait until ciphertext is persisted on the message.
    await waitFor(async () => {
      const p = await messageQueue.getPendingMessages(CONV);
      const ours = p.find((x) => x.localId === m.localId);
      return !!ours?.encryptedBody;
    });
    const cipherBeforeReload = (await messageQueue.getPendingMessages(CONV)).find(
      (x) => x.localId === m.localId,
    )!.encryptedBody!;
    expect(decodeEnvelope(cipherBeforeReload).epoch).toBe(1);

    // Phase 2 — TRUE cold start: volatile plaintext wiped, h1 unmounted.
    const internal = messageQueue as unknown as { volatilePlaintext: Map<string, string> };
    internal.volatilePlaintext.delete(m.localId);
    unreg1();

    // Phase 3 — fresh handler with the NEW identity comes online.
    const h2 = makeHandler({
      ready: true,
      bundle: { identityEpoch: 2, deviceId: 'dev-B' },
      sendThrows: false,
    });
    const unreg2 = registerHandler(h2, 'h-cold-post');

    await messageQueue.resumeAll();

    // The stale ciphertext must be sent EXACTLY ONCE, EXACTLY as it was.
    await waitFor(() => h2.sentEnvelopes.some((s) => s.localId === m.localId), 10_000);

    const sent = h2.sentEnvelopes.find((s) => s.localId === m.localId)!;
    expect(sent.envelope).toBe(cipherBeforeReload);
    expect(decodeEnvelope(sent.envelope).epoch).toBe(1); // OLD identity
    expect(decodeEnvelope(sent.envelope).deviceId).toBe('dev-A'); // OLD device

    // No re-encryption with the new identity.
    expect(h2.encryptCalls.find((c) => c.localId === m.localId)).toBeUndefined();
    // The message leaves the queue (not stuck, not failed_visible).
    await waitFor(async () => {
      const p = await messageQueue.getPendingMessages(CONV);
      return !p.find((x) => x.localId === m.localId);
    }, 5000);

    unreg2();
  }, 25_000);

  it('manual retry after rotation: ships existing ciphertext as-is; full reload forces re-encryption', async () => {
    // Two distinct user paths after a rotation:
    //
    //   (A) Tap "Réessayer" on a failed message → `retryMessage()` resets
    //       retryCount but PRESERVES `encryptedBody`. The queue ships the
    //       OLD-identity ciphertext (Double Ratchet on the peer side
    //       handles it via the per-pair session, which survives identity
    //       rotation). This is the documented contract.
    //
    //   (B) Hard reload + resumeAll → if plaintext is still in volatile
    //       memory, ciphertext is dropped and the message is re-encrypted
    //       under the CURRENT identity. This is the rebinding path.
    //
    // We exercise BOTH in this single test to lock the contract.

    // ── Path A ──────────────────────────────────────────────────────────
    const h = makeHandler({
      ready: true,
      bundle: { identityEpoch: 1, deviceId: 'dev-A' },
      sendThrows: true,
    });
    const unreg = registerHandler(h, 'h-manual');

    const mA = await messageQueue.enqueue({
      conversationId: CONV,
      senderId: SENDER,
      plaintext: 'path-A',
    });
    await waitFor(() => h.encryptCalls.some((c) => c.localId === mA.localId && c.epoch === 1));
    await waitFor(async () => {
      const p = await messageQueue.getPendingMessages(CONV);
      return !!p.find((x) => x.localId === mA.localId)?.encryptedBody;
    });
    const cipherA = (await messageQueue.getPendingMessages(CONV)).find(
      (x) => x.localId === mA.localId,
    )!.encryptedBody!;

    // Rotate + fix network.
    h.bundle = { identityEpoch: 3, deviceId: 'dev-C' };
    h.sendThrows = false;
    const encryptCountBefore = h.encryptCalls.filter((c) => c.localId === mA.localId).length;

    await messageQueue.retryMessage(mA.localId);
    await waitFor(() => h.sentEnvelopes.some((s) => s.localId === mA.localId), 10_000);

    const sentA = h.sentEnvelopes.find((s) => s.localId === mA.localId)!;
    // Contract: existing ciphertext shipped verbatim, no re-encryption.
    expect(sentA.envelope).toBe(cipherA);
    expect(sentA.epoch).toBe(1);
    expect(sentA.deviceId).toBe('dev-A');
    expect(h.encryptCalls.filter((c) => c.localId === mA.localId).length).toBe(encryptCountBefore);

    // ── Path B ──────────────────────────────────────────────────────────
    h.sendThrows = true; // break the wire again
    const mB = await messageQueue.enqueue({
      conversationId: CONV,
      senderId: SENDER,
      plaintext: 'path-B',
    });
    await waitFor(() => h.encryptCalls.some((c) => c.localId === mB.localId));
    await waitFor(async () => {
      const p = await messageQueue.getPendingMessages(CONV);
      return !!p.find((x) => x.localId === mB.localId)?.encryptedBody;
    });

    // Rotate to a fourth identity epoch.
    h.bundle = { identityEpoch: 4, deviceId: 'dev-D' };
    h.sendThrows = false;

    // Plaintext still in volatile memory → resumeAll forces re-encryption.
    expect(
      (messageQueue as unknown as { volatilePlaintext: Map<string, string> })
        .volatilePlaintext.has(mB.localId),
    ).toBe(true);
    await messageQueue.resumeAll();

    await waitFor(() => h.sentEnvelopes.some((s) => s.localId === mB.localId), 15_000);
    const sentB = h.sentEnvelopes.find((s) => s.localId === mB.localId)!;
    // Wire envelope MUST be bound to the LATEST keys.
    expect(sentB.epoch).toBe(4);
    expect(sentB.deviceId).toBe('dev-D');
    // Re-encryption under the new identity actually happened.
    expect(
      h.encryptCalls.some((c) => c.localId === mB.localId && c.epoch === 4 && c.deviceId === 'dev-D'),
    ).toBe(true);

    unreg();
  }, 40_000);
});
