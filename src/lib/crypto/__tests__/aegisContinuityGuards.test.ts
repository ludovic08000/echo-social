import { describe, expect, it, vi } from 'vitest';
import {
  createSingleFlightByKey,
  decidePasswordChangeReadiness,
  decideMasterKeyCreation,
  evaluateServerContinuityProbe,
  selectPortableAccountIdentityRows,
} from '@/lib/crypto/aegisContinuityGuards';

describe('Aegis continuity guards', () => {
  it('treats any incomplete server inspection as unavailable', () => {
    expect(evaluateServerContinuityProbe({
      activeIdentity: false,
      accountBackup: false,
      activeIdentityError: true,
      accountBackupError: false,
    })).toBe('unavailable');
  });

  it('detects continuity from identity or account backup', () => {
    expect(evaluateServerContinuityProbe({
      activeIdentity: true,
      accountBackup: false,
      activeIdentityError: false,
      accountBackupError: false,
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
    })).toBe('create_first_key');
  });

  it('requires recovery when any server mechanism already references a Master Key', () => {
    expect(decideMasterKeyCreation({
      complete: true,
      localIdentityFingerprint: 'ACCOUNT-A',
      activeIdentityFingerprint: 'ACCOUNT-A',
      hasAccountBackup: false,
      hasRecoveryBackup: true,
    })).toBe('recovery_required');
  });

  it('fails closed on incomplete inspection or an identity mismatch', () => {
    const base = {
      localIdentityFingerprint: 'ACCOUNT-A',
      activeIdentityFingerprint: 'ACCOUNT-B',
      hasAccountBackup: false,
      hasRecoveryBackup: false,
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

describe('changement de mot de passe et continuité Master Key', () => {
  it('autorise uniquement une Master Key active ou un compte sans coffre', () => {
    expect(decidePasswordChangeReadiness({
      hasActiveMasterKey: true,
      hasAccountBackup: true,
      inspectionFailed: false,
    })).toBe('ready');
    expect(decidePasswordChangeReadiness({
      hasActiveMasterKey: false,
      hasAccountBackup: false,
      inspectionFailed: false,
    })).toBe('no_backup');
  });

  it('exige la récupération et échoue fermé si le serveur est incertain', () => {
    expect(decidePasswordChangeReadiness({
      hasActiveMasterKey: false,
      hasAccountBackup: true,
      inspectionFailed: false,
    })).toBe('recovery_required');
    expect(decidePasswordChangeReadiness({
      hasActiveMasterKey: false,
      hasAccountBackup: false,
      inspectionFailed: true,
    })).toBe('unavailable');
  });
});
