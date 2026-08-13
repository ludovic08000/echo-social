import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('account and device backup privacy contract', () => {
  it('never exports or imports decrypted message history', () => {
    const source = readFileSync('src/lib/crypto/accountKeyBackup.ts', 'utf8');

    expect(source).not.toContain('exportPlaintextCache');
    expect(source).not.toContain('importPlaintextCache');
    expect(source).not.toContain("data['plaintext:cache']");
  });
});
