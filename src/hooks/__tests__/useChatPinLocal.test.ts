import { beforeEach, describe, expect, it } from 'vitest';
import { __test__ } from '@/hooks/useChatPin';
import {
  deleteWrappedKeys,
  hasWrappedKeys,
  wrapKeysWithPin,
} from '@/lib/crypto/pinWrap';
import { openDB } from '@/lib/crypto/dbRegistry';

const USER_ID = '11111111-1111-4111-8111-111111111111';

describe('local-only messaging PIN', () => {
  beforeEach(async () => {
    await __test__.removeLocalPin(USER_ID).catch(() => undefined);
    await deleteWrappedKeys(USER_ID).catch(() => undefined);
  });

  it('verifies locally and rejects an incorrect PIN', async () => {
    await __test__.saveLocalPin(USER_ID, '123456');

    await expect(__test__.verifyLocalPin(USER_ID, '123456')).resolves.toBe(true);
    await expect(__test__.verifyLocalPin(USER_ID, '654321')).resolves.toBe(false);
  });

  it('stores only an encrypted verifier and never the PIN', async () => {
    await __test__.saveLocalPin(USER_ID, '123456');
    const record = await __test__.loadLocalPin(USER_ID);

    expect(record?.version).toBe(3);
    expect(JSON.stringify(record)).not.toContain('123456');
    expect(record?.wrappedBlob).toBeTruthy();
  });

  it('builds a replacement verifier without overwriting the current local PIN', async () => {
    await __test__.saveLocalPin(USER_ID, '123456');
    const current = await __test__.loadLocalPin(USER_ID);
    const candidate = await __test__.createLocalPinRecord(USER_ID, '654321');

    expect(candidate.wrappedBlob).not.toBe(current?.wrappedBlob);
    await expect(__test__.verifyLocalPin(USER_ID, '123456')).resolves.toBe(true);
    await expect(__test__.verifyLocalPin(USER_ID, '654321')).resolves.toBe(false);

    await __test__.persistLocalRecord(USER_ID, candidate);
    await expect(__test__.verifyLocalPin(USER_ID, '123456')).resolves.toBe(false);
    await expect(__test__.verifyLocalPin(USER_ID, '654321')).resolves.toBe(true);
  });

  it('keeps the UI PIN verifier isolated from the wrapped E2EE identity', async () => {
    const db = await openDB('pin-wrap');
    expect(db.objectStoreNames.contains('pin-verifiers')).toBe(true);
    expect(db.objectStoreNames.contains('wrapped-keys')).toBe(true);
    expect(db.objectStoreNames.contains('pin-wrapped-keys')).toBe(false);

    await __test__.saveLocalPin(USER_ID, '123456');
    await expect(hasWrappedKeys(USER_ID)).resolves.toBe(false);

    await wrapKeysWithPin(USER_ID, '654321', {
      publicKeyJWK: { kty: 'EC', crv: 'P-256', x: 'public-x', y: 'public-y' },
      privateKeyJWK: { kty: 'EC', crv: 'P-256', d: 'private-d' },
      signingPublicKeyJWK: { kty: 'EC', crv: 'P-256', x: 'sign-x', y: 'sign-y' },
      signingPrivateKeyJWK: { kty: 'EC', crv: 'P-256', d: 'sign-d' },
      fingerprint: 'test-fingerprint',
      createdAt: Date.now(),
    });

    await expect(__test__.verifyLocalPin(USER_ID, '123456')).resolves.toBe(true);
    await expect(hasWrappedKeys(USER_ID)).resolves.toBe(true);

    await __test__.removeLocalPin(USER_ID);
    await expect(hasWrappedKeys(USER_ID)).resolves.toBe(true);
  });
});
