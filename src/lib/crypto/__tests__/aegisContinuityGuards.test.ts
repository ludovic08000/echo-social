import { describe, expect, it, vi } from 'vitest';
import {
  createSingleFlightByKey,
  decideMasterKeyCreation,
  evaluateServerContinuityProbe,
  selectPortableAccountIdentityRows,
} from '@/lib/crypto/aegisContinuityGuards';

describe('Aegis continuity guards', () => {
  it('treats any incomplete server inspection as unavailable', () => {
    expect(evaluateServerContinuityProbe({
      activeIdentity: false,
      accountBackup: false,
      backupPin: false,
      activeIdentityError: true,
      accountBackupError: false,
      backupPinError: false,
    })).toBe('unavailable');
  });

  it('detects continuity from identity, account backup, or PIN backup', () => {
    expect(evaluateServerContinuityProbe({
      activeIdentity: false,
      accountBackup: false,
      backupPin: true,
      activeIdentityError: false,
      accountBackupError: false,
      backupPinError: false,
    })).toBe('continuity');
  });

  it('coalesces concurrent initialization into one authoritative operation', async () => {
    const run = createSingleFlightByKey<string>();
    const factory = vi.fn(async () => {
      await Promise.resolve();
      return 'same-master-key';
    });

    const [first, second] = await Promise.all([
      run('account-1', factory),
      run('account-1', factory),
    ]);

    expect(first).toBe('same-master-key');
    expect(second).toBe('same-master-key');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('creates a Master Key only for a matching local identity with no recovery evidence', () => {
    expect(decideMasterKeyCreation({
      complete: true,
      localIdentityFingerprint: 'ACCOUNT-A',
      activeIdentityFingerprint: 'ACCOUNT-A',
      hasAccountBackup: false,
      hasRecoveryBackup: false,
      hasPinBackup: false,
    })).toBe('create_first_key');
  });

  it('requires recovery when any server mechanism already references a Master Key', () => {
    expect(decideMasterKeyCreation({
      complete: true,
      localIdentityFingerprint: 'ACCOUNT-A',
      activeIdentityFingerprint: 'ACCOUNT-A',
      hasAccountBackup: false,
      hasRecoveryBackup: true,
      hasPinBackup: false,
    })).toBe('recovery_required');
  });

  it('fails closed on incomplete inspection or an identity mismatch', () => {
    const base = {
      localIdentityFingerprint: 'ACCOUNT-A',
      activeIdentityFingerprint: 'ACCOUNT-B',
      hasAccountBackup: false,
      hasRecoveryBackup: false,
      hasPinBackup: false,
    };
    expect(decideMasterKeyCreation({ ...base, complete: false })).toBe('unavailable');
    expect(decideMasterKeyCreation({ ...base, complete: true })).toBe('identity_mismatch');
  });

  it('exports and restores only the permanent identity owned by the account', () => {
    const rows = [
      { id: 'account-a', private: 'A' },
      { id: 'account-b', private: 'B' },
      { id: 'device-kx::phone', private: 'DEVICE' },
      { id: null, private: 'UNKNOWN' },
    ];
    expect(selectPortableAccountIdentityRows(rows, 'account-a')).toEqual([
      { id: 'account-a', private: 'A' },
    ]);
  });
});
