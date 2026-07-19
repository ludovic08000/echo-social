import { describe, expect, it } from 'vitest';
import {
  AEGIS_KEY_PROTOCOL,
  AEGIS_MESSAGE_PROTOCOL,
  createAegisMessage,
  openAegisMessage,
  parseAegisKeyCapsule,
  parseAegisMessageEnvelope,
} from '@/lib/messaging/aegisEnvelope';

const ids = {
  messageId: '11111111-1111-4111-8111-111111111111',
  conversationId: '22222222-2222-4222-8222-222222222222',
  senderId: '33333333-3333-4333-8333-333333333333',
};

describe('Aegis message envelope v1', () => {
  it('encrypts the payload once and opens it with the matching device key capsule', async () => {
    const created = await createAegisMessage({ ...ids, plaintext: 'message secret' });

    expect(created.body).not.toContain('message secret');
    expect(created.keyCapsule).not.toContain('message secret');
    expect(parseAegisMessageEnvelope(created.body)?.protocol).toBe(AEGIS_MESSAGE_PROTOCOL);
    expect(parseAegisKeyCapsule(created.keyCapsule)?.protocol).toBe(AEGIS_KEY_PROTOCOL);
    await expect(openAegisMessage(created.body, created.keyCapsule, ids))
      .resolves.toBe('message secret');
  });

  it('binds the ciphertext and capsule to the stable message UUID', async () => {
    const created = await createAegisMessage({ ...ids, plaintext: 'message secret' });

    await expect(openAegisMessage(created.body, created.keyCapsule, {
      ...ids,
      messageId: '44444444-4444-4444-8444-444444444444',
    })).resolves.toBeNull();
  });

  it('rejects a capsule from another encrypted message', async () => {
    const first = await createAegisMessage({ ...ids, plaintext: 'first' });
    const second = await createAegisMessage({
      ...ids,
      messageId: '55555555-5555-4555-8555-555555555555',
      plaintext: 'second',
    });

    await expect(openAegisMessage(first.body, second.keyCapsule, ids)).resolves.toBeNull();
  });

  it('rejects ciphertext tampering before attempting plaintext rendering', async () => {
    const created = await createAegisMessage({ ...ids, plaintext: 'message secret' });
    const parsed = JSON.parse(created.body);
    parsed.ciphertext = `${parsed.ciphertext.slice(0, -2)}AA`;

    await expect(openAegisMessage(JSON.stringify(parsed), created.keyCapsule, ids))
      .resolves.toBeNull();
  });
});
