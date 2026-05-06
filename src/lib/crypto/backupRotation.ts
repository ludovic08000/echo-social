import { createSecureBackupVault } from './secureBackupVault';

const ROTATION_INTERVAL_MS = 1000 * 60 * 60 * 24 * 30;
const ROTATION_KEY = 'forsure-backup-last-rotation:';

function key(userId: string) {
  return `${ROTATION_KEY}${userId}`;
}

export function getLastBackupRotation(userId: string): number {
  const raw = localStorage.getItem(key(userId));
  const value = raw ? Number(raw) : 0;
  return Number.isFinite(value) ? value : 0;
}

export function markBackupRotation(userId: string): void {
  localStorage.setItem(key(userId), String(Date.now()));
}

export async function rotateEncryptedBackupVault(userId: string): Promise<void> {
  const vault = await createSecureBackupVault(userId);
  if (!vault) return;

  markBackupRotation(userId);

  try {
    window.dispatchEvent(new CustomEvent('forsure-e2ee-backup-rotated', {
      detail: {
        userId,
        fingerprint: vault.fingerprint,
        recoveryKey: vault.recoveryKey,
      },
    }));
  } catch {}
}

export async function ensureBackupRotation(userId: string): Promise<void> {
  const last = getLastBackupRotation(userId);
  if (Date.now() - last < ROTATION_INTERVAL_MS) return;

  await rotateEncryptedBackupVault(userId);
}
