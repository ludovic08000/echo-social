const RECOVERY_FLAG = 'forsure-recovery-pending';

function getLocationHash() {
  return typeof window === 'undefined' ? '' : window.location.hash;
}

export function hasRecoveryHash(hash = getLocationHash()): boolean {
  return hash.includes('type=recovery') || hash.includes('access_token=') || hash.includes('refresh_token=');
}

export function setRecoveryFlag() {
  sessionStorage.setItem(RECOVERY_FLAG, '1');
}

export function clearRecoveryFlag() {
  sessionStorage.removeItem(RECOVERY_FLAG);
}

export function isRecoveryPending(): boolean {
  return sessionStorage.getItem(RECOVERY_FLAG) === '1';
}

export function detectAndStoreRecoveryFromHash(hash = getLocationHash()): boolean {
  const detected = hasRecoveryHash(hash);

  if (detected) {
    setRecoveryFlag();
  }

  return detected;
}