/**
 * keySentinel — Secure pointer that links an installation to a server-side E2EE backup.
 *
 * Stored in:
 *   iOS  → Keychain (kSecAttrAccessibleAfterFirstUnlock)
 *   Android → Keystore (AES-GCM)
 *   Web → Capacitor Preferences mirror → localStorage fallback
 *
 * Contains NO secret material — only:
 *   - userId of the account this device is bound to
 *   - SHA-256 digest of the local crypto state at the moment of last successful sync
 *   - lastSyncAt timestamp
 *   - backupVersion (server format version we last wrote/read)
 *
 * Purpose:
 *   On a cold start (iOS/Android) where IndexedDB has been purged by the OS but
 *   the OS-level Keychain entry survives, the sentinel proves:
 *     "this device used to own E2EE state for user X — a server backup exists,
 *      ask the user to unlock so we can pull it down."
 *
 *   It lets the app skip the wrong "no backup" path and surface the precise
 *   recovery flow (PIN unlock, password re-auth, or recovery key).
 */

import { secureGet, secureSet, secureRemove } from '@/lib/secureStore';

const SENTINEL_KEY = 'forsure-key-sentinel-v1';

export interface KeySentinel {
  userId: string;
  digest: string;          // SHA-256 of local crypto state at last sync
  lastSyncAt: number;      // epoch ms
  backupVersion: number;   // server backup version
}

export async function readKeySentinel(): Promise<KeySentinel | null> {
  try {
    const raw = await secureGet(SENTINEL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed && typeof parsed === 'object' &&
      typeof parsed.userId === 'string' &&
      typeof parsed.digest === 'string' &&
      typeof parsed.lastSyncAt === 'number' &&
      typeof parsed.backupVersion === 'number'
    ) {
      return parsed as KeySentinel;
    }
    return null;
  } catch (e) {
    console.warn('[keySentinel] read failed:', e);
    return null;
  }
}

export async function writeKeySentinel(sentinel: KeySentinel): Promise<void> {
  try {
    await secureSet(SENTINEL_KEY, JSON.stringify(sentinel));
  } catch (e) {
    console.warn('[keySentinel] write failed:', e);
  }
}

export async function clearKeySentinel(): Promise<void> {
  try { await secureRemove(SENTINEL_KEY); } catch {}
}
