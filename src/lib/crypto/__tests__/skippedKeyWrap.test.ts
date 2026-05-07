import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import { wrapSkippedJwk, unwrapSkippedJwk, isWrappedSkippedEntry, purgeSkippedWrapKey } from '../skippedKeyWrap';

describe('Lot A3 — skipped key wrap', () => {
  it('wrap → unwrap round-trips a JWK', async () => {
    const jwk: JsonWebKey = { kty: 'oct', k: 'AAAAAAAAAAAAAAAAAAAAAA', alg: 'A256GCM', ext: true };
    const w = await wrapSkippedJwk(jwk);
    expect(w.startsWith('v1.')).toBe(true);
    expect(isWrappedSkippedEntry(w)).toBe(true);
    const back = await unwrapSkippedJwk(w);
    expect(back).toEqual(jwk);
  });

  it('returns null on tampered ciphertext', async () => {
    const jwk: JsonWebKey = { kty: 'oct', k: 'BBBBBBBBBBBBBBBBBBBBBB', alg: 'A256GCM', ext: true };
    const w = await wrapSkippedJwk(jwk);
    const tampered = w.slice(0, -4) + 'XXXX';
    const back = await unwrapSkippedJwk(tampered);
    expect(back).toBeNull();
  });

  it('rejects raw JWK objects in isWrappedSkippedEntry guard', () => {
    expect(isWrappedSkippedEntry({ kty: 'oct' })).toBe(false);
    expect(isWrappedSkippedEntry('plain-string')).toBe(false);
    expect(isWrappedSkippedEntry('v1.abc')).toBe(true);
  });

  it('purge clears the cached wrap key (next call still works with new key)', async () => {
    const jwk: JsonWebKey = { kty: 'oct', k: 'CCCCCCCCCCCCCCCCCCCCCC', alg: 'A256GCM', ext: true };
    const w1 = await wrapSkippedJwk(jwk);
    await purgeSkippedWrapKey();
    // Old wrap is no longer decryptable since SWK rotated
    const back = await unwrapSkippedJwk(w1);
    expect(back).toBeNull();
    // New wrap → unwrap still works
    const w2 = await wrapSkippedJwk(jwk);
    expect(await unwrapSkippedJwk(w2)).toEqual(jwk);
  });
});
