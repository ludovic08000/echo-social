import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('private device material storage contract', () => {
  it('uses authenticated vault storage for every web platform without plaintext mirrors', () => {
    const vault = readFileSync('src/lib/crypto/deviceVault.ts', 'utf8');
    const identity = readFileSync('src/lib/crypto/deviceIdentity.ts', 'utf8');
    const keyExchange = readFileSync('src/lib/crypto/deviceKx.ts', 'utf8');
    const recovery = readFileSync('src/lib/crypto/aegisDeviceKeyVault.ts', 'utf8');

    expect(vault).toContain("type DeviceVaultMode = 'native' | 'web'");
    expect(vault).toContain('await deleteLegacy();');
    expect(vault).not.toContain('deviceVaultMirrorsPlaintext');
    expect(identity).not.toContain('function dbPut');
    expect(keyExchange).not.toContain('function dbPut');
    expect(recovery).toContain('store.delete(plain.signing.id)');
    expect(recovery).toContain('store.delete(plain.kx.id)');
    expect(vault).not.toContain("'legacy-web'");
    expect(vault).not.toContain("'ios-web'");
  });
});
