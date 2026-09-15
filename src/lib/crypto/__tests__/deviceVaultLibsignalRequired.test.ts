import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ decrypt: vi.fn(), restore: vi.fn(), write: vi.fn() }));
vi.mock('../cryptoIntegrity', () => ({
  hardCrypto: { decrypt: mocks.decrypt },
  hardGlobals: { TextEncoder, TextDecoder, atob, btoa, jsonParse: JSON.parse },
}));
vi.mock('../accountKeyBackup', () => ({ getSessionMasterKey: () => ({}) }));
vi.mock('../deviceVault', () => ({ deviceVaultMirrorsPlaintext: () => false, readDeviceVaultRecord: vi.fn(), writeDeviceVaultRecord: mocks.write }));
vi.mock('../libsignalPlatformBridge', () => ({ restoreLibsignalStore: mocks.restore }));
vi.mock('../x3dh', () => ({ restoreDeviceX3dhPrivatePrekeys: vi.fn() }));
vi.mock('../deviceSessionStore', () => ({ restoreDeviceSessionSnapshot: vi.fn() }));
import { restoreEncryptedWebDeviceVault } from '../webDeviceKeyVault';
const userId = 'alice';
const deviceId = `dev_${'a'.repeat(32)}`;
const key = Buffer.alloc(32, 1).toString('base64url');
const record = (type: string, crv: string) => ({
  id: `device-${type}::${userId}::${deviceId}`, userId, deviceId, createdAt: 1,
  publicKeyJWK: { kty: 'OKP', crv, x: key },
  privateKeyJWK: { kty: 'OKP', crv, x: key, d: key },
});
const plain = () => ({ version: 1, userId, deviceId, signing: record('signing', 'Ed25519'), kx: record('kx', 'X25519'), x3dh: { records: [] }, sessions: { sessions: [], initiating: [] }, libsignalStore: 'A'.repeat(40) });
const input = { userId, deviceId, vault: { version: 1 as const, iv: Buffer.alloc(12).toString('base64url'), ciphertext: 'AQID' }, expectedDeviceSigningKey: key + '=', expectedDevicePublicKey: key + '=' };
const decoded = (value: unknown) => mocks.decrypt.mockResolvedValue(new TextEncoder().encode(JSON.stringify(value)).buffer);
beforeEach(() => { vi.resetAllMocks(); mocks.restore.mockResolvedValue(undefined); });
describe('complete encrypted device vault required', () => {
  it.each([undefined, '', 42])('rejects missing/invalid Libsignal data before any private write: %s', async libsignalStore => {
    decoded({ ...plain(), libsignalStore });
    await expect(restoreEncryptedWebDeviceVault(input)).rejects.toThrow('DEVICE_VAULT_VAULT_INVALID');
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.restore).not.toHaveBeenCalled();
  });
  it('restores Libsignal before the other keys', async () => {
    decoded(plain());
    await restoreEncryptedWebDeviceVault(input);
    expect(mocks.restore).toHaveBeenCalledWith(userId, deviceId, 'A'.repeat(40));
    expect(mocks.write).toHaveBeenCalledTimes(2);
    expect(mocks.restore.mock.invocationCallOrder[0]).toBeLessThan(mocks.write.mock.invocationCallOrder[0]);
  });
  it('does not modify other keys if Libsignal refuses a stale backup', async () => {
    decoded(plain());
    mocks.restore.mockRejectedValue(new Error('AEGIS_LIBSIGNAL_RESTORE_CONFLICT'));
    await expect(restoreEncryptedWebDeviceVault(input)).rejects.toThrow('RESTORE_CONFLICT');
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
