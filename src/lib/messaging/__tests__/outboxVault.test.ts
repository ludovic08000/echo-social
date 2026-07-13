import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: webcrypto,
    });
  }
});

import { STORE_OUTBOX } from '@/lib/crypto/constants';
import { openE2EEDB } from '@/lib/crypto/indexedDb';
import { reqToPromise, runTx } from '@/lib/crypto/indexedDbTx';
import {
  deleteOutboxPayload,
  getOutboxPayload,
  listOutboxPayloads,
  patchOutboxPayload,
  putOutboxPayload,
  type OutboxPayload,
} from '@/lib/messaging/outboxVault';

const USER = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';

function payload(overrides: Partial<OutboxPayload> = {}): OutboxPayload {
  return {
    localId: 'local-outbox-test',
    traceId: 'trace-outbox-test',
    conversationId: CONVERSATION,
    senderId: USER,
    plaintext: 'texte ultra secret à ne jamais stocker en clair',
    encryptedBody: null,
    imageUrl: null,
    extra: { view_once: false },
    status: 'encrypting',
    retryCount: 0,
    maxRetries: 3,
    lastError: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    reservedServerId: null,
    ...overrides,
  };
}

describe('encrypted outbox vault', () => {
  it('round-trips a pending message while raw IndexedDB contains no plaintext', async () => {
    await openE2EEDB();
    await putOutboxPayload(USER, payload());

    const restored = await getOutboxPayload(USER, 'local-outbox-test');
    expect(restored?.plaintext).toBe('texte ultra secret à ne jamais stocker en clair');
    expect(restored?.conversationId).toBe(CONVERSATION);

    const raw = await runTx([STORE_OUTBOX], 'readonly', (tx) =>
      reqToPromise(tx.objectStore(STORE_OUTBOX).get('local-outbox-test')),
    ) as { ciphertext: ArrayBuffer };
    const rawBytes = new Uint8Array(raw.ciphertext);
    const rawText = new TextDecoder().decode(rawBytes);
    expect(rawText).not.toContain('texte ultra secret');

    const listed = await listOutboxPayloads(USER, CONVERSATION);
    expect(listed.map((entry) => entry.localId)).toContain('local-outbox-test');
  });

  it('serializes concurrent writes and keeps the last requested status', async () => {
    const first = putOutboxPayload(USER, payload({ status: 'encrypting' }));
    const second = putOutboxPayload(USER, payload({
      status: 'sending',
      encryptedBody: 'ciphertext-v1',
      reservedServerId: '33333333-3333-4333-8333-333333333333',
    }));

    await Promise.all([first, second]);
    const restored = await getOutboxPayload(USER, 'local-outbox-test');
    expect(restored?.status).toBe('sending');
    expect(restored?.encryptedBody).toBe('ciphertext-v1');
    expect(restored?.reservedServerId).toBe('33333333-3333-4333-8333-333333333333');
  });

  it('persists status and reserved server id for duplicate-safe retry', async () => {
    const patched = await patchOutboxPayload(USER, 'local-outbox-test', {
      status: 'retry_pending',
      lastError: 'restored',
    });

    expect(patched?.status).toBe('retry_pending');
    expect(patched?.reservedServerId).toBe('33333333-3333-4333-8333-333333333333');

    await deleteOutboxPayload('local-outbox-test');
    await expect(getOutboxPayload(USER, 'local-outbox-test')).resolves.toBeNull();
  });
});
