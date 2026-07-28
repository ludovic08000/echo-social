import { beforeEach, describe, expect, it } from 'vitest';
import {
  __test__,
  clearRecoveryFlag,
  detectAndStoreRecoveryFromHash,
  isRecoveryPending,
  prepareNormalSignIn,
  setRecoveryFlag,
} from '@/lib/authRecovery';

describe('auth recovery state', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState({}, '', '/login');
    window.location.hash = '';
  });

  it('clears the legacy permanent marker on the normal login route', () => {
    sessionStorage.setItem(__test__.recoveryFlag, '1');

    expect(isRecoveryPending()).toBe(false);
    expect(sessionStorage.getItem(__test__.recoveryFlag)).toBeNull();
  });

  it('keeps a legacy marker while the reset page is active', () => {
    window.history.replaceState({}, '', '/reset-password');
    sessionStorage.setItem(__test__.recoveryFlag, '1');

    expect(isRecoveryPending()).toBe(true);
  });

  it('expires timestamped recovery state', () => {
    window.history.replaceState({}, '', '/reset-password');
    setRecoveryFlag(1_000);

    expect(isRecoveryPending(1_000 + __test__.recoveryTtlMs + 1)).toBe(false);
    expect(sessionStorage.getItem(__test__.recoveryFlag)).toBeNull();
  });

  it('detects only an explicit recovery hash', () => {
    expect(detectAndStoreRecoveryFromHash('#access_token=x&type=recovery')).toBe(true);
    expect(sessionStorage.getItem(__test__.recoveryFlag)).not.toBeNull();

    clearRecoveryFlag();
    expect(detectAndStoreRecoveryFromHash('#access_token=x&type=signup')).toBe(false);
    expect(sessionStorage.getItem(__test__.recoveryFlag)).toBeNull();
  });

  it('clears abandoned recovery state before normal password sign-in', () => {
    setRecoveryFlag();
    prepareNormalSignIn();

    expect(sessionStorage.getItem(__test__.recoveryFlag)).toBeNull();
  });
});
