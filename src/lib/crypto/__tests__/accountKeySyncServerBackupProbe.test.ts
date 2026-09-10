import { describe, it, expect, vi, beforeEach } from 'vitest';

const probe = { result: { data: [] as unknown[], error: null as unknown } };

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            limit: async () => probe.result,
          }),
        }),
      }),
    }),
  },
}));

vi.mock('@/lib/crypto/accountKeyBackup', () => ({
  hasLocalKeys: vi.fn(async () => false),
  restoreAccountKeysFromActiveSession: vi.fn(async () => 'no_backup'),
  restoreKeysFromKeychainSnapshot: vi.fn(async () => 'not_found'),
  syncKeychainSnapshotFromLocal: vi.fn(async () => undefined),
}));

vi.mock('@/lib/crypto/pinWrap', () => ({ hasWrappedKeys: vi.fn(async () => false) }));
vi.mock('@/lib/crypto/keyManager', () => ({ hasRawIdentityKeys: vi.fn(async () => false) }));
vi.mock('@/lib/nativeStore', () => ({ isNativePlatform: () => false }));
vi.mock('@/lib/crypto/CryptoStateMachine', () => ({
  transition: vi.fn(),
  getSnapshot: () => ({ state: 'idle' }),
  withEnsureLock: async (_id: string, run: () => Promise<void>) => run(),
}));

const sentinel = { value: null as null | { userId: string; digest: string; lastSyncAt: number } };
vi.mock('@/lib/crypto/keySentinel', () => ({ readKeySentinel: async () => sentinel.value }));

import { synchronizeAccountKeysBeforeRuntime, AccountKeyRestoreRequiredError } from '../accountKeySync';

function captureRestoreEvents(): string[] {
  const reasons: string[] = [];
  window.addEventListener('forsure:e2ee-restore-needed', (e) => {
    reasons.push(((e as CustomEvent).detail as { reason: string }).reason);
  });
  return reasons;
}

describe('accountKeySync — preuve serveur de sauvegarde', () => {
  beforeEach(() => {
    sentinel.value = null;
    probe.result = { data: [], error: null };
  });

  it('bloque quand une sauvegarde serveur existe sans sentinelle locale', async () => {
    const reasons = captureRestoreEvents();
    probe.result = { data: [{ id: 'b1' }], error: null };
    await expect(synchronizeAccountKeysBeforeRuntime('u1')).rejects.toBeInstanceOf(AccountKeyRestoreRequiredError);
    expect(reasons).toContain('server_backup_without_sentinel');
  });

  it('bloque sans erreur de cardinalité avec plusieurs sauvegardes historiques', async () => {
    probe.result = { data: [{ id: 'b1' }], error: null };
    sentinel.value = { userId: 'u1', digest: 'd', lastSyncAt: 1 };
    await expect(synchronizeAccountKeysBeforeRuntime('u1')).rejects.toMatchObject({
      restoreReason: 'cold_start_sentinel',
    });
  });

  it('bloque fail-closed si la lecture serveur échoue', async () => {
    probe.result = { data: null, error: { message: 'network down' } };
    await expect(synchronizeAccountKeysBeforeRuntime('u1')).rejects.toMatchObject({
      restoreReason: 'account_backup_probe_failed',
    });
  });

  it('autorise un compte neuf uniquement sans sauvegarde serveur ni clés locales', async () => {
    const outcome = await synchronizeAccountKeysBeforeRuntime('u1');
    expect(outcome).toBe('no_backup_new_account');
  });
});
