import { describe, expect, it } from 'vitest';
import { redactCryptoDiagnostic } from '@/lib/crypto/errorLogger';

describe('crypto diagnostic redaction', () => {
  it('removes keys, ciphertext, media keys and bearer-like tokens', () => {
    const value = [
      'contentKey=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      'ciphertext: BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
      '\x00MKEY:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=',
      'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signaturevalue123456',
    ].join(' ');
    const redacted = redactCryptoDiagnostic(value);
    expect(redacted).toContain('[REDACTED');
    expect(redacted).not.toContain('AAAAAAAAAAAAAAAA');
    expect(redacted).not.toContain('BBBBBBBBBBBBBBBB');
    expect(redacted).not.toContain('CCCCCCCCCCCCCCCC');
    expect(redacted).not.toContain('eyJhbGci');
  });
});
