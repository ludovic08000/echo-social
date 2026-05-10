/**
 * memoryIdentityCache — in-RAM hot cache for the local E2EE identity.
 *
 * Purpose
 * -------
 * Holds non-extractable CryptoKey references and the local device id so the
 * app can keep operating during the brief windows when IndexedDB is
 * unavailable (Safari/iOS background, ITP wipe between tx, version bump).
 *
 * Rules
 * -----
 *  - RAM only. Never persisted, never serialized, never logged.
 *  - Cleared on logout, lock, idle, security-epoch change, hidden-too-long.
 *  - Read paths first try this cache, then IndexedDB, then trigger restore.
 *  - Writes only happen from `keyManager` after a successful load/restore/create.
 */

export interface CachedIdentity {
  /** owning user id */
  userId: string;
  /** persistent device id for this browser */
  deviceId?: string;
  /** non-extractable X25519 private key (Web Crypto CryptoKey) */
  identityPrivate?: CryptoKey;
  /** non-extractable X25519 public key */
  identityPublic?: CryptoKey;
  /** opaque blob of last-known ratchet header for fast resume */
  hotState?: Uint8Array;
  /** monotonic version, bumped on every set() */
  version: number;
  /** last refresh timestamp (ms) */
  updatedAt: number;
}

const cache = new Map<string, CachedIdentity>();

let installedListeners = false;

function installListenersOnce() {
  if (installedListeners || typeof window === 'undefined') return;
  installedListeners = true;

  window.addEventListener('forsure-e2ee-security-epoch-changed', () => clearAll('epoch_changed'));
  window.addEventListener('forsure-e2ee-security-code-changed', () => clearAll('code_changed'));
  window.addEventListener('forsure:e2ee-lock', () => clearAll('app_lock'));
  window.addEventListener('forsure:logout', () => clearAll('logout'));

  // Hidden-too-long → conservative purge after 5 min in background.
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  document.addEventListener('visibilitychange', () => {
    if (hiddenTimer) {
      clearTimeout(hiddenTimer);
      hiddenTimer = null;
    }
    if (document.visibilityState === 'hidden') {
      hiddenTimer = setTimeout(() => clearAll('hidden_idle_5m'), 5 * 60 * 1000);
    }
  });
}

export function get(userId: string): CachedIdentity | undefined {
  installListenersOnce();
  return cache.get(userId);
}

export function set(userId: string, patch: Partial<Omit<CachedIdentity, 'userId' | 'version' | 'updatedAt'>>): CachedIdentity {
  installListenersOnce();
  const prev = cache.get(userId);
  const next: CachedIdentity = {
    userId,
    deviceId: patch.deviceId ?? prev?.deviceId,
    identityPrivate: patch.identityPrivate ?? prev?.identityPrivate,
    identityPublic: patch.identityPublic ?? prev?.identityPublic,
    hotState: patch.hotState ?? prev?.hotState,
    version: (prev?.version ?? 0) + 1,
    updatedAt: Date.now(),
  };
  cache.set(userId, next);
  return next;
}

export function clear(userId: string, reason = 'manual'): void {
  if (cache.delete(userId)) {
    console.log('[E2EE][memcache] cleared', { userId: userId.slice(0, 8), reason });
  }
}

export function clearAll(reason = 'manual'): void {
  if (cache.size === 0) return;
  console.log('[E2EE][memcache] clear all', { reason, size: cache.size });
  cache.clear();
}

export function has(userId: string): boolean {
  return cache.has(userId);
}
