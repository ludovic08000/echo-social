import { describe, expect, it, vi } from 'vitest';
import {
  createSingleFlightByKey,
  evaluateServerContinuityProbe,
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
});
