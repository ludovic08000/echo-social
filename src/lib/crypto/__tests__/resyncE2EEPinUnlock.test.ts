import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class PinUnlockRequiredError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'PinUnlockRequiredError';
    }
  }

  return {
    PinUnlockRequiredError,
    hasLocalKeys: vi.fn(),
    syncAvailableBackupsToServer: vi.fn(),
    syncKeychainSnapshotFromLocal: vi.fn(),
    getOrCreateIdentityKeys: vi.fn(),
    exportPublicKeyBundle: vi.fn(),
    exportPublicKeyBundleFromStoredKeys: vi.fn(),
    fetchServerIdentityState: vi.fn(),
    identityBundleMatchesServer: vi.fn(),
    refreshSignedPrekeyIfNeeded: vi.fn(),
    refreshDeviceSignedPrekeyIfNeeded: vi.fn(),
    refillDeviceOneTimePrekeysIfNeeded: vi.fn(),
    getOrCreateDeviceKxKey: vi.fn(),
    clearAllDeviceSessions: vi.fn(),
    tryReadDeviceCopy: vi.fn(),
    logCryptoError: vi.fn(),
    logCryptoException: vi.fn(),
    from: vi.fn(),
    order: [] as string[],
    chatPinBackupExists: true,
    conversations: [] as Array<{ conversation_id: string }>,
    messages: [] as Array<{ id: string; body: string | null; body_kind?: string | null; sender_id: string }>,
  };
});

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: mocks.from,
  },
}));

vi.mock('@/lib/messaging/currentDevice', () => ({
  getCurrentDeviceId: () => 'device-12345678',
  getCurrentDeviceLabel: () => 'Test browser',
  getCurrentPlatform: () => 'web',
  hydrateDeviceId: vi.fn(async () => 'device-12345678'),
}));

vi.mock('@/lib/crypto/keyManager', () => ({
  getOrCreateIdentityKeys: mocks.getOrCreateIdentityKeys,
  exportPublicKeyBundle: mocks.exportPublicKeyBundle,
  exportPublicKeyBundleFromStoredKeys: mocks.exportPublicKeyBundleFromStoredKeys,
  fetchServerIdentityState: mocks.fetchServerIdentityState,
  identityBundleMatchesServer: mocks.identityBundleMatchesServer,
  PinUnlockRequiredError: mocks.PinUnlockRequiredError,
}));

vi.mock('@/lib/crypto/x3dh', () => ({
  refreshSignedPrekeyIfNeeded: mocks.refreshSignedPrekeyIfNeeded,
  refreshDeviceSignedPrekeyIfNeeded: mocks.refreshDeviceSignedPrekeyIfNeeded,
  refillDeviceOneTimePrekeysIfNeeded: mocks.refillDeviceOneTimePrekeysIfNeeded,
}));

vi.mock('@/lib/crypto/deviceKx', () => ({
  getOrCreateDeviceKxKey: mocks.getOrCreateDeviceKxKey,
}));

vi.mock('@/lib/crypto/deviceRatchet', () => ({
  clearAllDeviceSessions: mocks.clearAllDeviceSessions,
}));

vi.mock('@/lib/messaging/multiDeviceFanout', () => ({
  tryReadDeviceCopy: mocks.tryReadDeviceCopy,
}));

vi.mock('@/lib/crypto/accountKeyBackup', () => ({
  hasLocalKeys: mocks.hasLocalKeys,
  syncAvailableBackupsToServer: mocks.syncAvailableBackupsToServer,
  syncKeychainSnapshotFromLocal: mocks.syncKeychainSnapshotFromLocal,
}));

vi.mock('@/lib/crypto/errorLogger', () => ({
  logCryptoError: mocks.logCryptoError,
  logCryptoException: mocks.logCryptoException,
}));

import { resyncE2EE } from '../resyncE2EE';

function queryFor(table: string) {
  const query: any = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(async () => {
      if (table === 'messages') return { data: mocks.messages, error: null };
      return { data: [], error: null };
    }),
    maybeSingle: vi.fn(async () => {
      if (table === 'user_backups' && mocks.chatPinBackupExists) {
        return { data: { id: 'backup-1' }, error: null };
      }
      return { data: null, error: null };
    }),
    upsert: vi.fn(async () => ({ error: null })),
    then: (resolve: (value: any) => void, reject?: (reason: any) => void) => {
      const value =
        table === 'conversation_participants'
          ? { data: mocks.conversations, error: null }
          : { data: [], error: null };
      return Promise.resolve(value).then(resolve, reject);
    },
  };
  return query;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mocks.order = [];
  mocks.chatPinBackupExists = true;
  mocks.conversations = [];
  mocks.messages = [];
  mocks.from.mockImplementation((table: string) => queryFor(table));
  mocks.hasLocalKeys.mockResolvedValue(true);
  mocks.syncAvailableBackupsToServer.mockImplementation(async () => {
    mocks.order.push('backup');
    return true;
  });
  mocks.syncKeychainSnapshotFromLocal.mockResolvedValue(true);
  mocks.getOrCreateIdentityKeys.mockResolvedValue({ signingPrivateKey: {} });
  mocks.exportPublicKeyBundle.mockResolvedValue({
    identityKey: 'a'.repeat(44),
    signingKey: 'b'.repeat(44),
    fingerprint: 'fp-1',
  });
  mocks.fetchServerIdentityState.mockResolvedValue(null);
  mocks.identityBundleMatchesServer.mockReturnValue(true);
  mocks.getOrCreateDeviceKxKey.mockResolvedValue({ publicB64: 'c'.repeat(44) });
  mocks.clearAllDeviceSessions.mockResolvedValue(undefined);
  mocks.refreshSignedPrekeyIfNeeded.mockResolvedValue(undefined);
  mocks.refreshDeviceSignedPrekeyIfNeeded.mockResolvedValue(undefined);
  mocks.refillDeviceOneTimePrekeysIfNeeded.mockResolvedValue(undefined);
  mocks.tryReadDeviceCopy.mockImplementation(async () => {
    mocks.order.push('replay');
    return 'recovered text';
  });
});

describe('resyncE2EE PIN unlock flow', () => {
  it('opens PIN unlock and never scans messages when local identity is missing but chat PIN backup exists', async () => {
    mocks.hasLocalKeys.mockResolvedValue(false);
    const events: any[] = [];
    window.addEventListener('forsure:e2ee-pin-unlock-required', (event) => {
      events.push((event as CustomEvent).detail);
    });

    const report = await resyncE2EE('user-1', { diagnostic: true });

    expect(report.needsPinUnlock).toBe(true);
    expect(report.steps.replay).toBe('skipped');
    expect(report.scannedMessages).toBe(0);
    expect(mocks.tryReadDeviceCopy).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalledWith('conversation_participants');
    expect(events[0]?.message).toBe('Déverrouillage requis pour restaurer vos messages chiffrés');
    expect(sessionStorage.getItem('forsure:e2ee-pin-unlock-required:user-1')).toContain('Déverrouillage requis');
  });

  it('opens PIN unlock and never replays when identity republish hits PinUnlockRequiredError', async () => {
    mocks.getOrCreateIdentityKeys.mockRejectedValue(
      new mocks.PinUnlockRequiredError('PIN unlock required to recover identity keys'),
    );

    const report = await resyncE2EE('user-1');

    expect(report.needsPinUnlock).toBe(true);
    expect(report.steps.identity).toBe('error');
    expect(report.steps.replay).toBe('skipped');
    expect(report.scannedMessages).toBe(0);
    expect(mocks.from).not.toHaveBeenCalledWith('conversation_participants');
    expect(mocks.tryReadDeviceCopy).not.toHaveBeenCalled();
  });

  it('replays messages before refreshing the post-restore backup when identity is ready', async () => {
    mocks.conversations = [{ conversation_id: 'conv-1' }];
    mocks.messages = [{
      id: 'msg-1',
      body: 'v5.encrypted',
      body_kind: 'multi_device',
      sender_id: 'peer-1',
    }];

    const report = await resyncE2EE('user-1');

    expect(report.steps.identity).toBe('ok');
    expect(report.steps.replay).toBe('ok');
    expect(report.steps.backup).toBe('ok');
    expect(report.recoveredMessages).toBe(1);
    expect(mocks.order).toEqual(['replay', 'backup']);
  });
});
