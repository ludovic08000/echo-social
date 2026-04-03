/**
 * Encrypted vs non-encrypted conversation detection
 * 
 * Verifies the system correctly distinguishes:
 * - Valid encrypted envelopes (legacy + ratchet)
 * - Plaintext messages
 * - Malformed/partial JSON
 */
import { describe, it, expect } from 'vitest';
import { isEncryptedMessage } from '../e2ee';

function isRatchetEnvelope(body: string): boolean {
  if (!body.startsWith('{')) return false;
  try {
    const p = JSON.parse(body);
    return p.v !== undefined && p.hdr !== undefined && p.ct !== undefined;
  } catch {
    return false;
  }
}

function isAnyEncryptedMessage(body: string): boolean {
  return isEncryptedMessage(body) || isRatchetEnvelope(body);
}

describe('Encrypted vs non-encrypted detection', () => {
  it('detects legacy encrypted envelope', () => {
    const legacy = JSON.stringify({
      v: 2, kem: 'X25519', iv: 'abc', ct: 'def', sig: 'ghi', fp: 'x', ts: Date.now(), seq: 0,
    });
    expect(isAnyEncryptedMessage(legacy)).toBe(true);
    expect(isEncryptedMessage(legacy)).toBe(true);
    expect(isRatchetEnvelope(legacy)).toBe(false);
  });

  it('detects ratchet envelope', () => {
    const ratchet = JSON.stringify({
      v: 2, kem: 'X25519', hdr: { dh: 'pubkey', pn: 0, n: 0 },
      iv: 'abc', ct: 'def', sig: 'ghi', fp: 'x', ts: Date.now(),
    });
    expect(isAnyEncryptedMessage(ratchet)).toBe(true);
    expect(isRatchetEnvelope(ratchet)).toBe(true);
  });

  it('detects X3DH initial message (ratchet + x3dh header)', () => {
    const x3dh = JSON.stringify({
      v: 2, kem: 'X25519', hdr: { dh: 'pubkey', pn: 0, n: 0 },
      iv: 'abc', ct: 'def', sig: 'ghi', fp: 'x', ts: Date.now(),
      x3dh: { ik: 'identityKey', ek: 'ephemeralKey', spkId: 1 },
    });
    expect(isAnyEncryptedMessage(x3dh)).toBe(true);
  });

  it('rejects all plaintext as non-encrypted', () => {
    const plaintexts = [
      'Bonjour!',
      'Hello world',
      '',
      '123456',
      'null',
      'undefined',
      '<html>XSS</html>',
      '{"name":"John","age":30}',  // JSON but not an envelope
      'eyJhbGciOiJIUzI1NiJ9',     // base64 but not JSON
    ];
    for (const pt of plaintexts) {
      expect(isAnyEncryptedMessage(pt)).toBe(false);
    }
  });

  it('rejects incomplete envelopes', () => {
    // Missing ct
    expect(isEncryptedMessage(JSON.stringify({ v: 2, kem: 'X25519' }))).toBe(false);
    // Missing v
    expect(isEncryptedMessage(JSON.stringify({ kem: 'X25519', ct: 'x' }))).toBe(false);
    // Missing hdr for ratchet
    expect(isRatchetEnvelope(JSON.stringify({ v: 2, ct: 'x' }))).toBe(false);
  });

  it('handles edge cases gracefully', () => {
    expect(isAnyEncryptedMessage('{broken json')).toBe(false);
    expect(isAnyEncryptedMessage('[')).toBe(false);
    expect(isAnyEncryptedMessage('{"v":2,"kem":"X25519","ct":"x"}')).toBe(true);
  });
});
