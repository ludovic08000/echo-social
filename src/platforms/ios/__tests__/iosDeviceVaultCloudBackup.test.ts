import { beforeEach, describe, expect, it, vi } from 'vitest';

const DEVICE_ID = 'dev_0123456789abcdef0123456789abcdef';

const state = vi.hoisted(() => ({
  iosWeb: true,
  masterKey: true,
  localKeys: true,
  ready: true,
  backupOk: true,
  backups: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/platforms/ios/iosRuntime', () => ({
  isIosWebRuntime: () => state.iosWeb,
}));

vi.mock('@/lib/messaging/currentDevice', () => ({
  peekCurrentDeviceId: () => DEVICE_ID,
}));

vi.mock('@/lib/crypto/accountKeyBackup', () => ({
  getSessionMasterKey: () => state.masterKey ? ({} as CryptoKey) : null,
}));

vi.mock('@/lib/crypto/deviceIdentity', () => ({
  loadDeviceIdentity: async () => state.localKeys ? ({ publicB64: 'signing' }) : null,
}));

vi.mock('@/lib/crypto/deviceKx', () => ({
  loadDeviceKxKey: async () => state.localKeys ? ({ publicB64: 'kx' }) : null,
}));

vi.mock('@/lib/crypto/canonicalDeviceRegistry', () => ({
  fetchVerifiedDeviceIdentity: async () => null,
}));

vi.mock('@/lib/crypto/deviceVault', () => ({
  logDeviceVaultEvent: vi.fn(),
}));

vi.mock('@/lib/crypto/deviceVaultSync', () => ({
  backupDeviceVaultToCloud: async (args: Record<string, unknown>) => {
    state.backups.push(args);
    return state.backupOk;
  },
  restoreDeviceVaultFromCloud: async () => false,
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => {
      const chain: any = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = async () => ({
        data: state.ready ? {
          approval_status: 'approved',
          binding_status: 'bound',
          lifecycle_status: 'ready',
          routing_status: 'ready',
          is_active: true,
          revoked_at: null,
        } : {
          approval_status: 'approved',
          binding_status: 'bound',
          lifecycle_status: 'syncing',
          routing_status: 'repairing',
          is_active: true,
          revoked_at: null,
        },
        error: null,
      });
      return chain;
    },
  },
}));

async function load() {
  return import('@/platforms/ios/iosDeviceVaultRestore');
}

describe('iOS Web encrypted device vault backup', () => {
  beforeEach(() => {
    state.iosWeb = true;
    state.masterKey = true;
    state.localKeys = true;
    state.ready = true;
    state.backupOk = true;
    state.backups = [];
    vi.useRealTimers();
    vi.resetModules();
  });

  it('backs up only a READY iOS Web device and uses ios-web platform metadata', async () => {
    const vault = await load();
    await expect(vault.backupIosDeviceVaultIfReady('user-1')).resolves.toBe(true);

    expect(state.backups).toEqual([{
      userId: 'user-1',
      deviceId: DEVICE_ID,
      platform: 'ios-web',
    }]);
  });

  it('is a strict no-op outside iOS Web, preserving Windows/native paths', async () => {
    state.iosWeb = false;
    const vault = await load();
    await expect(vault.backupIosDeviceVaultIfReady('user-1')).resolves.toBe(false);
    expect(state.backups).toEqual([]);
  });

  it('retries after the server lifecycle becomes READY instead of losing the backup', async () => {
    vi.useFakeTimers();
    state.ready = false;
    const vault = await load();

    await expect(vault.backupIosDeviceVaultIfReady('user-1')).resolves.toBe(false);
    expect(state.backups).toEqual([]);

    state.ready = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.backups).toHaveLength(1);
    vault.__test__.resetBackupRetries();
  });

  it('does not upload when the account Master Key is unavailable', async () => {
    state.masterKey = false;
    vi.useFakeTimers();
    const vault = await load();

    await expect(vault.backupIosDeviceVaultIfReady('user-1')).resolves.toBe(false);
    expect(state.backups).toEqual([]);
    vault.__test__.resetBackupRetries();
  });
});
