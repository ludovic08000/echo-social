/**
 * memoryIdentityCache — in-RAM hot cache for the local E2EE identity.
 *
 * IndexedDB is only a local crypto cache. This RAM cache is the first read
 * layer during a live session so Safari/iOS IndexedDB closing/purge events do
 * not immediately force recovery or identity recreation.
 */

export interface CachedIdentity {
  userId: string;
  deviceId?: string;
  identityPrivate?: CryptoKey;
  identityPublic?: CryptoKey;
  signingPrivate?: CryptoKey;
  signingPublic?: CryptoKey;
  fingerprint?: string;
  createdAt?: number;
  hotState?: Uint8Array;
  version: number;
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
    signingPrivate: patch.signingPrivate ?? prev?.signingPrivate,
    signingPublic: patch.signingPublic ?? prev?.signingPublic,
    fingerprint: patch.fingerprint ?? prev?.fingerprint,
    createdAt: patch.createdAt ?? prev?.createdAt,
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
