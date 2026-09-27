import { describe, expect, it } from 'vitest';
import { decodeCallE2EEKey, generateCallE2EEKey, isValidCallE2EEKey } from '../callKey';

describe('Aegis call media keys', () => {
  it('generates and decodes exactly 256 bits', () => {
    const key = generateCallE2EEKey();
    expect(key).toHaveLength(44);
    expect(decodeCallE2EEKey(key)).toHaveLength(32);
    expect(isValidCallE2EEKey(key)).toBe(true);
  });

  it.each([
    '',
    'not-base64',
    btoa('too short'),
    `${btoa('x'.repeat(32)).slice(0, -2)}AA`,
    btoa('x'.repeat(32)).replace(/=+$/, ''),
  ])('rejects malformed or non-canonical material', (value) => {
    expect(() => decodeCallE2EEKey(value)).toThrow('CALL_KEY_INVALID');
    expect(isValidCallE2EEKey(value)).toBe(false);
  });
});
