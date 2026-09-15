import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hasStore: vi.fn(), restore: vi.fn(), identity: vi.fn(),
  signing: vi.fn(), kx: vi.fn(), masterKey: vi.fn(),
}));
vi.mock('@/platforms/ios/iosRuntime', () => ({ isIosWebRuntime: () => true }));
vi.mock('@/platforms/android/androidRuntime', () => ({ isAndroidRuntime: () => true }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/messaging/currentDevice', () => ({ peekCurrentDeviceId: () => 'dev_test' }));
vi.mock('@/lib/crypto/accountKeyBackup', () => ({ getSessionMasterKey: mocks.masterKey }));
vi.mock('@/lib/crypto/deviceIdentity', () => ({ loadDeviceIdentity: mocks.signing }));
vi.mock('@/lib/crypto/deviceKx', () => ({ loadDeviceKxKey: mocks.kx }));
vi.mock('@/lib/crypto/libsignalPlatformBridge', () => ({ hasLibsignalStore: mocks.hasStore }));
vi.mock('@/lib/crypto/canonicalDeviceRegistry', () => ({ fetchVerifiedDeviceIdentity: mocks.identity }));
vi.mock('@/lib/crypto/deviceVault', () => ({ logDeviceVaultEvent: vi.fn() }));
vi.mock('@/lib/crypto/deviceVaultSync', () => ({ restoreDeviceVaultFromCloud: mocks.restore, backupDeviceVaultToCloud: vi.fn() }));
import { ensureIosDeviceVaultRestored } from '../ios/iosDeviceVaultRestore';
import { restoreAndroidDeviceVault } from '../android/androidDeviceVault';

describe.each([
  { name: 'iOS web', run: ensureIosDeviceVaultRestored, restored: 'restored', untouched: 'not_needed', failed: 'failed' },
  { name: 'Android', run: restoreAndroidDeviceVault, restored: true, untouched: true, failed: false },
])('partial Libsignal store loss: $name', ({ run, restored, untouched, failed }) => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.signing.mockResolvedValue({ publicB64: 'signing' });
    mocks.kx.mockResolvedValue({ publicB64: 'kx' });
    mocks.masterKey.mockReturnValue({});
    mocks.hasStore.mockResolvedValue(false);
    mocks.identity.mockResolvedValue({ deviceSigningKey: 'signing', devicePublicKey: 'kx' });
    mocks.restore.mockResolvedValue(true);
  });
  it('restores when signing and KX keys survived but the Libsignal store did not', async () => {
    expect(await run('alice')).toBe(restored);
    expect(mocks.restore).toHaveBeenCalledWith({ userId: 'alice', deviceId: 'dev_test', expectedDeviceSigningKey: 'signing', expectedDevicePublicKey: 'kx' });
  });
  it('does not restore over a complete local device', async () => {
    mocks.hasStore.mockResolvedValue(true);
    expect(await run('alice')).toBe(untouched);
    expect(mocks.restore).not.toHaveBeenCalled();
  });
  it('propagates vault read failures instead of replacing private state', async () => {
    mocks.hasStore.mockRejectedValue(new Error('vault locked'));
    await expect(run('alice')).rejects.toThrow('vault locked');
    expect(mocks.restore).not.toHaveBeenCalled();
  });
  it('does not report a failed restore as usable', async () => {
    mocks.restore.mockResolvedValue(false);
    expect(await run('alice')).toBe(failed);
  });
  it('never restores an unknown device', async () => {
    mocks.identity.mockResolvedValue(null);
    await run('alice');
    expect(mocks.restore).not.toHaveBeenCalled();
  });
  it('never restores with the account key locked', async () => {
    mocks.masterKey.mockReturnValue(null);
    await run('alice');
    expect(mocks.restore).not.toHaveBeenCalled();
  });
});
