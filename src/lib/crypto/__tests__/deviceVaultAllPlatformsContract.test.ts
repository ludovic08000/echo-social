import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('private device material storage contract', () => {
  it('uses authenticated vault storage for every web platform without plaintext mirrors', () => {
    const source = readFileSync('src/lib/crypto/deviceVault.ts', 'utf8');

    expect(source).toContain("type DeviceVaultMode = 'native' | 'web'");
    expect(source).toContain("return mode() === 'native';");
    expect(source).not.toContain("'legacy-web'");
    expect(source).not.toContain("'ios-web'");
  });
});
