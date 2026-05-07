/**
 * Crash logger — captures the FIRST unhandled JavaScript error or React render
 * crash on the page, snapshots the surrounding crypto / auth context, and keeps
 * it available for the ErrorBoundary fallback UI to display.
 *
 * Goal: when Feed or Profil crash, the user (and us in chat) can see the real
 * stack trace + which crypto/identity primitives were available at crash time,
 * instead of a generic "Quelque chose s'est mal passé".
 */

export type CrashContext = {
  ts: string;
  route: string;
  message: string;
  source: 'window.error' | 'unhandledrejection' | 'react.boundary';
  stack?: string;
  componentStack?: string;
  crypto: {
    hasWindowCrypto: boolean;
    hasSubtle: boolean;
    hasIndexedDB: boolean;
    e2eeBootstrapMarker?: string | null;
    identityFingerprint?: string | null;
    deviceId?: string | null;
    localKeysPresent?: boolean;
    /** Names of keys in localStorage that look e2ee/forsure-related */
    e2eeKeys: string[];
  };
  ua: string;
};

const STORAGE_KEY = 'forsure:last-crash';
let captured = false;
let listeners: Array<(c: CrashContext) => void> = [];

function safeLocalStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function listE2eeKeys(): string[] {
  try {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (
        k.startsWith('forsure:') ||
        k.startsWith('e2ee:') ||
        k.includes('identity') ||
        k.includes('crypto') ||
        k.includes('device')
      ) {
        out.push(k);
      }
    }
    return out;
  } catch {
    return [];
  }
}

function snapshotCryptoContext(): CrashContext['crypto'] {
  const hasWindowCrypto = typeof crypto !== 'undefined';
  const hasSubtle = hasWindowCrypto && !!(crypto as Crypto).subtle;
  const hasIndexedDB = typeof indexedDB !== 'undefined';

  return {
    hasWindowCrypto,
    hasSubtle,
    hasIndexedDB,
    e2eeBootstrapMarker: safeLocalStorage('forsure:e2ee-bootstrap'),
    identityFingerprint: safeLocalStorage('forsure:identity-fingerprint'),
    deviceId: safeLocalStorage('forsure:device-id'),
    localKeysPresent: !!safeLocalStorage('forsure:local-keys'),
    e2eeKeys: listE2eeKeys(),
  };
}

export function captureCrash(input: {
  message: string;
  source: CrashContext['source'];
  stack?: string;
  componentStack?: string;
}): CrashContext | null {
  if (captured) return null; // first one only
  captured = true;

  const ctx: CrashContext = {
    ts: new Date().toISOString(),
    route: typeof location !== 'undefined' ? location.pathname + location.search : '',
    message: input.message,
    source: input.source,
    stack: input.stack,
    componentStack: input.componentStack,
    crypto: snapshotCryptoContext(),
    ua: typeof navigator !== 'undefined' ? navigator.userAgent : '',
  };

  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(ctx));
  } catch {}

  // Console output is the most reliable way for us to read it back from logs.
  // eslint-disable-next-line no-console
  console.error('[CRASH]', ctx);

  for (const fn of listeners) {
    try { fn(ctx); } catch {}
  }

  return ctx;
}

export function getLastCrash(): CrashContext | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CrashContext) : null;
  } catch {
    return null;
  }
}

export function clearLastCrash() {
  captured = false;
  try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
}

export function onCrash(fn: (c: CrashContext) => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((x) => x !== fn);
  };
}

let installed = false;
export function installGlobalCrashHandlers() {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (e) => {
    captureCrash({
      message: e.message || 'window.error',
      source: 'window.error',
      stack: e.error?.stack,
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason: any = e.reason;
    captureCrash({
      message:
        (reason && (reason.message || String(reason))) || 'unhandledrejection',
      source: 'unhandledrejection',
      stack: reason?.stack,
    });
  });
}
