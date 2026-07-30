import { createOrRotateAegisRecoveryVault } from './aegisRecoveryVault';

const ROTATION_INTERVAL_MS = 1000 * 60 * 60 * 24 * 30;
const ROTATION_KEY = 'forsure-backup-last-rotation:';

function key(userId: string): string {
  return `${ROTATION_KEY}${userId}`;
}

export function getLastBackupRotation(userId: string): number {
  try {
    const raw = localStorage.getItem(key(userId));
    const value = raw ? Number(raw) : 0;
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

export function markBackupRotation(userId: string): void {
  try {
    localStorage.setItem(key(userId), String(Date.now()));
  } catch {
    // Rotation remains valid when browser storage is unavailable.
  }
}

/**
 * Explicitly rotate the Aegis recovery vault.
 * The returned key must be shown once and saved before the caller dismisses it.
 */
export async function rotateEncryptedBackupVault(userId: string): Promise<string> {
  const created = await createOrRotateAegisRecoveryVault(userId);
  markBackupRotation(userId);
  try {
    window.dispatchEvent(new CustomEvent('forsure-e2ee-backup-rotated', {
      detail: {
        userId,
        fingerprint: created.fingerprint,
        generation: created.generation,
        recoveryKey: created.recoveryKey,
      },
    }));
  } catch {
    // Event delivery is optional; the return value remains authoritative.
  }
  return created.recoveryKey;
}

/**
 * Never rotate silently: that would invalidate the user's saved key without
 * proving the replacement was displayed and stored. This function only emits
 * a recommendation when the configured interval has elapsed.
 */
export async function ensureBackupRotation(userId: string): Promise<void> {
  const last = getLastBackupRotation(userId);
  if (last > 0 && Date.now() - last < ROTATION_INTERVAL_MS) return;
  try {
    window.dispatchEvent(new CustomEvent('forsure-e2ee-backup-rotation-recommended', {
      detail: { userId, lastRotationAt: last || null },
    }));
  } catch {
    // Best-effort notification only.
  }
}
