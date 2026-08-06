/**
 * Stable, account-scoped DeviceID routing identity.
 *
 * Security invariant: storage failures, key loss, reloads and sync failures may
 * never allocate a replacement DeviceID. A new identifier is created only by
 * beginExplicitDeviceEnrollment(), which must be called from an explicit user
 * action and is consumed by the server enrollment gate.
 */
import { nativeSet, nativeGetSync, isNativePlatform } from '@/lib/nativeStore';
import { secureGet, secureSet } from '@/lib/secureStore';
import { supabase } from '@/integrations/supabase/client';
import {
  authorizeExplicitDeviceEnrollment,
  type ExplicitDeviceEnrollmentReason,
} from '@/lib/crypto/deviceEnrollmentGate';

const BASE_STORAGE_KEY = 'forsure-device-id-v1';
const FINGERPRINT_KEY = 'forsure-device-fingerprint-v1';
const DEVICE_ID_DB = 'forsure-device-routing-v1';
const DEVICE_ID_STORE = 'device-ids';
const DEVICE_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export type DeviceIdentityErrorCode =
  | 'DEVICE_ID_INVALID'
  | 'DEVICE_ID_UNINITIALIZED'
  | 'DEVICE_ID_STORAGE_UNAVAILABLE'
  | 'DEVICE_ID_MISMATCH'
  | 'DEVICE_ID_REAPPROVAL_REQUIRED'
  | 'DEVICE_USER_SCOPE_REQUIRED';

export class DeviceIdentityError extends Error {
  readonly code: DeviceIdentityErrorCode;
  constructor(code: DeviceIdentityErrorCode) {
    super(code);
    this.name = 'DeviceIdentityError';
    this.code = code;
  }
}

let currentDeviceUserScope: string | null = null;
let memoryDeviceId: string | null = null;
let hydrationPromise: Promise<string> | null = null;
let memoryDeviceIdIsTemporary = false;
let explicitEnrollmentInProgress = false;
let cachedFingerprints: { strict: string; loose: string; ultraLoose: string } | null = null;

function storageKey(): string {
  return currentDeviceUserScope ? `${BASE_STORAGE_KEY}:${currentDeviceUserScope}` : BASE_STORAGE_KEY;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_ID_RE.test(value);
}

function readBrowserStorage(key: string): string[] {
  const values: string[] = [];
  try {
    const value = localStorage.getItem(key);
    if (validId(value)) values.push(value);
  } catch {
    // hydrateDeviceId performs durable reads and fails closed on errors.
  }
  try {
    const value = sessionStorage.getItem(key);
    if (validId(value)) values.push(value);
  } catch {
    // hydrateDeviceId performs durable reads and fails closed on errors.
  }
  try {
    const value = nativeGetSync(key);
    if (validId(value)) values.push(value);
  } catch {
    // hydrateDeviceId performs durable reads and fails closed on errors.
  }
  return values;
}

function readDeviceIdFromIndexedDb(key: string): Promise<string | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DEVICE_ID_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DEVICE_ID_STORE)) db.createObjectStore(DEVICE_ID_STORE);
    };
    request.onerror = () => reject(new DeviceIdentityError('DEVICE_ID_STORAGE_UNAVAILABLE'));
    request.onsuccess = () => {
      const db = request.result;
      let transaction: IDBTransaction;
      try {
        transaction = db.transaction(DEVICE_ID_STORE, 'readonly');
      } catch {
        db.close();
        reject(new DeviceIdentityError('DEVICE_ID_STORAGE_UNAVAILABLE'));
        return;
      }
      const get = transaction.objectStore(DEVICE_ID_STORE).get(key);
      get.onsuccess = () => {
        const value = get.result;
        db.close();
        if (value == null) resolve(null);
        else if (validId(value)) resolve(value);
        else reject(new DeviceIdentityError('DEVICE_ID_MISMATCH'));
      };
      get.onerror = () => {
        db.close();
        reject(new DeviceIdentityError('DEVICE_ID_STORAGE_UNAVAILABLE'));
      };
    };
  });
}

function writeDeviceIdToIndexedDb(key: string, id: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DEVICE_ID_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DEVICE_ID_STORE)) db.createObjectStore(DEVICE_ID_STORE);
    };
    request.onerror = () => reject(new DeviceIdentityError('DEVICE_ID_STORAGE_UNAVAILABLE'));
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(DEVICE_ID_STORE, 'readwrite');
      tx.objectStore(DEVICE_ID_STORE).put(id, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(new DeviceIdentityError('DEVICE_ID_STORAGE_UNAVAILABLE')); };
      tx.onabort = () => { db.close(); reject(new DeviceIdentityError('DEVICE_ID_STORAGE_UNAVAILABLE')); };
    };
  });
}

async function persistDurably(id: string): Promise<string> {
  if (!validId(id)) throw new DeviceIdentityError('DEVICE_ID_INVALID');
  const key = storageKey();
  let syncWrites = 0;
  try { localStorage.setItem(key, id); syncWrites += 1; } catch { /* checked below */ }
  try { sessionStorage.setItem(key, id); syncWrites += 1; } catch { /* checked below */ }

  const results = await Promise.allSettled([
    secureSet(key, id),
    nativeSet(key, id),
    writeDeviceIdToIndexedDb(key, id),
  ]);
  if (syncWrites === 0 && results.every(result => result.status === 'rejected')) {
    throw new DeviceIdentityError('DEVICE_ID_STORAGE_UNAVAILABLE');
  }
  memoryDeviceId = id;
  memoryDeviceIdIsTemporary = false;
  return id;
}

export function setCurrentDeviceUserScope(userId: string | null | undefined): void {
  const next = userId || null;
  if (currentDeviceUserScope === next) return;
  currentDeviceUserScope = next;
  memoryDeviceId = null;
  hydrationPromise = null;
  memoryDeviceIdIsTemporary = false;
  explicitEnrollmentInProgress = false;
  cachedFingerprints = null;
}

async function ensureUserScopeFromAuth(): Promise<void> {
  if (currentDeviceUserScope) return;
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user?.id) throw new DeviceIdentityError('DEVICE_USER_SCOPE_REQUIRED');
  setCurrentDeviceUserScope(user.id);
}

function generateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Explicit user action only. Never call from recovery/error catch blocks. */
export async function beginExplicitDeviceEnrollment(
  reason: ExplicitDeviceEnrollmentReason,
): Promise<string> {
  await ensureUserScopeFromAuth();
  authorizeExplicitDeviceEnrollment(reason);
  explicitEnrollmentInProgress = true;
  hydrationPromise = null;
  return persistDurably(generateId());
}

export function setCurrentDeviceId(id: string): string {
  if (!validId(id)) throw new DeviceIdentityError('DEVICE_ID_INVALID');
  const existing = memoryDeviceId ?? readBrowserStorage(storageKey())[0] ?? null;
  if (existing && existing !== id && !explicitEnrollmentInProgress) {
    throw new DeviceIdentityError('DEVICE_ID_MISMATCH');
  }
  memoryDeviceId = id;
  memoryDeviceIdIsTemporary = false;
  explicitEnrollmentInProgress = false;
  hydrationPromise = Promise.resolve(id);
  void persistDurably(id).catch(() => {
    memoryDeviceId = null;
    hydrationPromise = null;
  });
  return id;
}

export function adoptDeviceIdFromBackup(_legacyId: string): string {
  return getCurrentDeviceId();
}

/** Legacy API retained only to fail closed. */
export function rotateCurrentDeviceId(_reason = 'device-key-loss'): string {
  throw new DeviceIdentityError('DEVICE_ID_REAPPROVAL_REQUIRED');
}

export function getCurrentDeviceId(): string {
  if (memoryDeviceId) return memoryDeviceId;
  const candidates = [...new Set(readBrowserStorage(storageKey()))];
  if (candidates.length > 1) throw new DeviceIdentityError('DEVICE_ID_MISMATCH');
  if (candidates.length === 1) {
    memoryDeviceId = candidates[0];
    memoryDeviceIdIsTemporary = false;
    return candidates[0];
  }
  throw new DeviceIdentityError('DEVICE_ID_UNINITIALIZED');
}

export function isDeviceIdTemporary(): boolean {
  return memoryDeviceIdIsTemporary;
}

export async function hydrateDeviceId(): Promise<string> {
  await ensureUserScopeFromAuth();
  if (hydrationPromise) return hydrationPromise;
  hydrationPromise = (async () => {
    const key = storageKey();
    const reads = await Promise.allSettled([
      secureGet(key),
      readDeviceIdFromIndexedDb(key),
    ]);
    if (reads.some(result => result.status === 'rejected')) {
      throw new DeviceIdentityError('DEVICE_ID_STORAGE_UNAVAILABLE');
    }
    const candidates = new Set<string>(readBrowserStorage(key));
    for (const result of reads) {
      if (result.status === 'fulfilled' && validId(result.value)) candidates.add(result.value);
    }
    if (candidates.size > 1) throw new DeviceIdentityError('DEVICE_ID_MISMATCH');
    const id = [...candidates][0];
    if (!id) throw new DeviceIdentityError('DEVICE_ID_REAPPROVAL_REQUIRED');
    return persistDurably(id);
  })().catch(error => {
    hydrationPromise = null;
    memoryDeviceId = null;
    memoryDeviceIdIsTemporary = false;
    throw error;
  });
  return hydrationPromise;
}

async function sha256Hex(input: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function uaFamily(ua: string): string {
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/iPod/i.test(ua)) return 'iPod';
  if (/Android/i.test(ua)) return 'Android';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Unknown';
}

async function computeDeviceFingerprints(): Promise<{ strict: string; loose: string; ultraLoose: string }> {
  if (cachedFingerprints) return cachedFingerprints;
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const lang = (typeof navigator !== 'undefined' && navigator.language) || '';
  const cpu = String((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || '');
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } })();
  const screenValue = typeof screen === 'undefined'
    ? ''
    : `${Math.min(screen.width, screen.height)}x${Math.max(screen.width, screen.height)}x${screen.colorDepth}`;
  const family = uaFamily(ua);
  const scope = currentDeviceUserScope || '';
  cachedFingerprints = {
    strict: await sha256Hex([scope, ua, lang, cpu, tz, screenValue].join('|')),
    loose: await sha256Hex([scope, family, lang.split('-')[0] || '', tz].join('|')),
    ultraLoose: await sha256Hex(`platform:${family}:${scope}`),
  };
  try { localStorage.setItem(FINGERPRINT_KEY, cachedFingerprints.strict); } catch { /* advisory only */ }
  return cachedFingerprints;
}

export async function getDeviceFingerprint(): Promise<string> {
  return (await computeDeviceFingerprints()).strict;
}

export async function getDeviceFingerprintCandidates(): Promise<string[]> {
  const values = await computeDeviceFingerprints();
  return [values.strict, values.loose, values.ultraLoose];
}

export function getCurrentDeviceLabel(): string {
  if (typeof navigator === 'undefined') return 'Unknown device';
  const ua = navigator.userAgent || '';
  const isIPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  const os = /iPhone/i.test(ua) ? 'iPhone'
    : /iPad|iPod/i.test(ua) || isIPadOS ? 'iPad'
    : /Android/i.test(ua) ? 'Android'
    : /Windows/i.test(ua) ? 'Windows'
    : /Macintosh|Mac OS X/i.test(ua) ? 'macOS'
    : /Linux/i.test(ua) ? 'Linux'
    : 'Unknown OS';
  const browser = /EdgA?|EdgiOS/i.test(ua) ? 'Edge'
    : /CriOS|Chrome/i.test(ua) ? 'Chrome'
    : /FxiOS|Firefox/i.test(ua) ? 'Firefox'
    : /OPiOS|OPR\//i.test(ua) ? 'Opera'
    : /Safari/i.test(ua) ? 'Safari'
    : 'Browser';
  return isNativePlatform() ? `${os} · App` : `${browser} · ${os}`;
}

export function getCurrentPlatform(): string {
  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent || '';
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  }
  return isNativePlatform() ? 'mobile' : 'web';
}

export const __test__ = {
  validId,
  reset(): void {
    currentDeviceUserScope = null;
    memoryDeviceId = null;
    hydrationPromise = null;
    memoryDeviceIdIsTemporary = false;
    explicitEnrollmentInProgress = false;
    cachedFingerprints = null;
  },
};
