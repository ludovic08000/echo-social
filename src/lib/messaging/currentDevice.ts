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
  cancelExplicitDeviceEnrollmentAuthorization,
  type ExplicitDeviceEnrollmentReason,
} from '@/lib/crypto/deviceEnrollmentGate';
import { readIosDeviceIdAnchor, writeIosDeviceIdAnchor } from '@/platforms/ios/iosDeviceIdAnchor';

const BASE_STORAGE_KEY = 'forsure-device-id-v1';
const DEVICE_ID_DB = 'forsure-device-routing-v1';
const DEVICE_ID_STORE = 'device-ids';
const DEVICE_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const SERVER_DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;
const EXPLICIT_ENROLLMENT_TRANSITION_TTL_MS = 10 * 60_000;

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
let explicitEnrollmentExpiresAt = 0;

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

function cancelLocalEnrollmentTransition(): void {
  explicitEnrollmentInProgress = false;
  explicitEnrollmentExpiresAt = 0;
  cancelExplicitDeviceEnrollmentAuthorization();
}

export function setCurrentDeviceUserScope(userId: string | null | undefined): void {
  const next = userId || null;
  if (currentDeviceUserScope === next) return;
  cancelLocalEnrollmentTransition();
  currentDeviceUserScope = next;
  memoryDeviceId = null;
  hydrationPromise = null;
  memoryDeviceIdIsTemporary = false;
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
  explicitEnrollmentExpiresAt = Date.now() + EXPLICIT_ENROLLMENT_TRANSITION_TTL_MS;
  hydrationPromise = null;
  try {
    return await persistDurably(generateId());
  } catch (error) {
    cancelLocalEnrollmentTransition();
    throw error;
  }
}

export function setCurrentDeviceId(id: string): string {
  if (!validId(id)) throw new DeviceIdentityError('DEVICE_ID_INVALID');
  const existing = memoryDeviceId ?? readBrowserStorage(storageKey())[0] ?? null;
  const serverTransitionAllowed = explicitEnrollmentInProgress
    && explicitEnrollmentExpiresAt > Date.now()
    && SERVER_DEVICE_ID_RE.test(id);
  if (existing && existing !== id && !serverTransitionAllowed) {
    throw new DeviceIdentityError('DEVICE_ID_MISMATCH');
  }
  memoryDeviceId = id;
  memoryDeviceIdIsTemporary = false;
  cancelLocalEnrollmentTransition();
  hydrationPromise = Promise.resolve(id);
  void persistDurably(id).catch(() => {
    memoryDeviceId = null;
    hydrationPromise = null;
  });
  return id;
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

export type CurrentDeviceIdStatus =
  | 'ok'
  | 'uninitialized'
  | 'mismatch'
  | 'storage_unavailable';

/** Non-throwing read for lifecycle/UI state. */
export function peekCurrentDeviceId(): string | null {
  try {
    return getCurrentDeviceId();
  } catch {
    return null;
  }
}

export function getDeviceIdStatus(): CurrentDeviceIdStatus {
  try {
    getCurrentDeviceId();
    return 'ok';
  } catch (error) {
    const code = error instanceof DeviceIdentityError ? error.code : 'DEVICE_ID_STORAGE_UNAVAILABLE';
    if (code === 'DEVICE_ID_UNINITIALIZED') return 'uninitialized';
    if (code === 'DEVICE_ID_MISMATCH' || code === 'DEVICE_ID_REAPPROVAL_REQUIRED') return 'mismatch';
    return 'storage_unavailable';
  }
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
    cancelLocalEnrollmentTransition();
    currentDeviceUserScope = null;
    memoryDeviceId = null;
    hydrationPromise = null;
    memoryDeviceIdIsTemporary = false;
  },
};
