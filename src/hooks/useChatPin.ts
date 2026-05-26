/**
 * useChatPin — PIN-based access control for messaging
 * 
 * The PIN is cryptographically tied to E2EE key decryption:
 * - PIN → PBKDF2 (600k iterations) → AES-256-GCM wrapping key
 * - Identity keys in IndexedDB are encrypted with this wrapping key
 * - Without the correct PIN, keys cannot be decrypted → messages unreadable
 * - PIN hash (SHA-256 with random salt) stored server-side for verification
 * - Unlocked state persists for the session only (sessionStorage flag)
 * 
 * PIN modes:
 * - every_open: Ask PIN every time messaging is opened (default, most secure)
 * - once_per_session: Ask PIN once after login, then free access
 * - on_inactivity: Re-ask PIN after 5 minutes of inactivity
 * - on_return: Re-ask PIN when user returns to the tab/app after leaving
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { hardCrypto, hardGlobals } from '@/lib/crypto/cryptoIntegrity';
import { reqToPromise, runTxOn } from '@/lib/crypto/indexedDbTx';

export type PinMode = 'every_open' | 'once_per_session' | 'on_inactivity' | 'on_return';

const SESSION_KEY = 'forsure-pin-unlocked';
const PIN_WRAP_STORE = 'pin-wrapped-keys';   // unified store (matches pinWrap.ts)
const PIN_WRAP_LEGACY_STORE = 'wrapped-keys'; // read-only fallback for migration
const PBKDF2_ITERATIONS = 600_000;
const INACTIVITY_TIMEOUT = 5 * 60_000; // 5 minutes
const PIN_MODES: PinMode[] = ['every_open', 'once_per_session', 'on_inactivity', 'on_return'];

// ─── Types ───

export interface ChatPinState {
  /** true once we know whether PIN exists */
  loaded: boolean;
  /** true if user has set up a PIN */
  hasPin: boolean;
  /** true if PIN is verified this session */
  unlocked: boolean;
  /** Error message */
  error: string | null;
  /** Loading state for async operations */
  processing: boolean;
  /** Current PIN mode */
  pinMode: PinMode;
  /** true when local E2EE material must be restored with the PIN before messaging opens */
  restoreRequired: boolean;
  /** Server/UI-safe PIN attempt counters */
  pinFailedAttempts: number;
  pinAttemptsRemaining: number;
  pinRetryAfterSeconds: number;
  pinLockedUntil: string | null;
  /** Last backup secret release was attested by the edge function */
  pinReleaseAttestationOk: boolean;
}

// ─── IndexedDB for wrapped keys ───

async function saveWrappedKeys(userId: string, data: {
  wrappedBlob: string;
  iv: string;
  salt: string;
}) {
  await runTxOn('pin-wrap', PIN_WRAP_STORE, 'readwrite', (store) => {
    // Persist using BOTH the useChatPin schema and the pinWrap.ts schema
    // so any reader (KeyBackupPanel, accountKeyBackup, resyncE2EE) can decode it.
    store.put({
      id: userId,
      // useChatPin shape
      wrappedBlob: data.wrappedBlob,
      iv: data.iv,
      salt: data.salt,
      // pinWrap.ts compatibility shape
      ciphertext: data.wrappedBlob,
      version: 1,
    });
  });
}

async function encryptAndSaveWrappedCrypto(
  userId: string,
  wrapKey: CryptoKey,
  saltB64: string,
  blob: string,
): Promise<void> {
  const iv = hardCrypto.getRandomValues(new Uint8Array(12));
  const plainBytes = new TextEncoder().encode(blob);
  const ciphertext = await hardCrypto.encrypt(
    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer> },
    wrapKey,
    plainBytes as Uint8Array<ArrayBuffer>,
  );

  await saveWrappedKeys(userId, {
    wrappedBlob: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
    salt: saltB64,
  });
  console.log('[PIN] wrapped blob persisted into unified store', PIN_WRAP_STORE);
}

async function loadWrappedKeys(userId: string): Promise<{
  wrappedBlob: string;
  iv: string;
  salt: string;
} | null> {
  try {
    // 1) Try unified store first
    const fromUnified = await runTxOn('pin-wrap', PIN_WRAP_STORE, 'readonly', (store) =>
      reqToPromise<any>(store.get(userId)),
    );

    if (fromUnified) {
      // Accept either useChatPin shape or pinWrap.ts shape
      const wrappedBlob = fromUnified.wrappedBlob ?? fromUnified.ciphertext;
      if (wrappedBlob && fromUnified.iv && fromUnified.salt) {
        return { wrappedBlob, iv: fromUnified.iv, salt: fromUnified.salt };
      }
    }

    // 2) Legacy fallback — migrate to unified store on the fly
    const fromLegacy = await runTxOn('pin-wrap', PIN_WRAP_LEGACY_STORE, 'readonly', (store) =>
      reqToPromise<any>(store.get(userId)),
    ).catch(() => null);

    if (fromLegacy?.wrappedBlob && fromLegacy.iv && fromLegacy.salt) {
      console.warn('[PIN] migrating legacy wrapped-keys → pin-wrapped-keys');
      await saveWrappedKeys(userId, {
        wrappedBlob: fromLegacy.wrappedBlob,
        iv: fromLegacy.iv,
        salt: fromLegacy.salt,
      });
      // Best-effort cleanup of legacy entry
      await runTxOn('pin-wrap', PIN_WRAP_LEGACY_STORE, 'readwrite', (store) => {
        store.delete(userId);
      }).catch(() => undefined);
      return {
        wrappedBlob: fromLegacy.wrappedBlob,
        iv: fromLegacy.iv,
        salt: fromLegacy.salt,
      };
    }

    return null;
  } catch (e) {
    console.warn('[PIN] loadWrappedKeys failed', e);
    return null;
  }
}

// ─── Crypto helpers ───

function base64ToBytes(b64: string): Uint8Array {
  const bin = hardGlobals.atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return hardGlobals.btoa(bin);
}

const PIN_MAX_ATTEMPTS = 5;

type PinAttemptState = Pick<
  ChatPinState,
  'pinFailedAttempts' | 'pinAttemptsRemaining' | 'pinRetryAfterSeconds' | 'pinLockedUntil'
>;

interface PinReleaseAttestation {
  version: 'svr2';
  action: 'release_backup_pin_blob';
  userId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  backupSecretHash: string;
  signature: string;
}

const PIN_ATTEMPT_RESET: PinAttemptState = {
  pinFailedAttempts: 0,
  pinAttemptsRemaining: PIN_MAX_ATTEMPTS,
  pinRetryAfterSeconds: 0,
  pinLockedUntil: null,
};

function pinAttemptStateFromServer(payload: any): PinAttemptState {
  const failed = Number.isFinite(Number(payload?.failedAttempts))
    ? Math.max(0, Number(payload.failedAttempts))
    : Math.max(0, PIN_MAX_ATTEMPTS - Number(payload?.attemptsRemaining ?? PIN_MAX_ATTEMPTS));
  const remaining = Number.isFinite(Number(payload?.attemptsRemaining))
    ? Math.max(0, Number(payload.attemptsRemaining))
    : Math.max(0, PIN_MAX_ATTEMPTS - failed);
  const retryAfter = Number.isFinite(Number(payload?.retryAfterSeconds))
    ? Math.max(0, Number(payload.retryAfterSeconds))
    : 0;
  return {
    pinFailedAttempts: failed,
    pinAttemptsRemaining: remaining,
    pinRetryAfterSeconds: retryAfter,
    pinLockedUntil: typeof payload?.lockedUntil === 'string' ? payload.lockedUntil : null,
  };
}

async function readFunctionErrorPayload(error: unknown): Promise<any | null> {
  const response = (error as { context?: unknown } | null)?.context;
  if (!response || typeof (response as Response).clone !== 'function') return null;
  try {
    return await (response as Response).clone().json();
  } catch {
    return null;
  }
}

function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i];
  return result === 0;
}

function canonicalReleasePayload(payload: Omit<PinReleaseAttestation, 'signature'>): string {
  return JSON.stringify({
    version: payload.version,
    action: payload.action,
    userId: payload.userId,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    nonce: payload.nonce,
    backupSecretHash: payload.backupSecretHash,
  });
}

async function sha256BytesBase64(bytes: Uint8Array): Promise<string> {
  return bytesToBase64(new Uint8Array(await hardCrypto.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)));
}

async function hmacBase64(secretB64: string, payload: string): Promise<string> {
  const key = await hardCrypto.importKey(
    'raw',
    base64ToBytes(secretB64) as Uint8Array<ArrayBuffer>,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await hardCrypto.sign('HMAC', key, new TextEncoder().encode(payload));
  return bytesToBase64(new Uint8Array(sig));
}

async function verifyBackupReleaseAttestation(
  backupSecret: string,
  attestation: unknown,
  userId: string,
): Promise<boolean> {
  const att = attestation as Partial<PinReleaseAttestation> | null;
  if (!att || att.version !== 'svr2' || att.action !== 'release_backup_pin_blob') return false;
  if (att.userId !== userId || !att.signature || !att.expiresAt || !att.issuedAt || !att.nonce || !att.backupSecretHash) {
    return false;
  }
  const expiresAt = new Date(att.expiresAt).getTime();
  const issuedAt = new Date(att.issuedAt).getTime();
  const now = Date.now();
  if (!Number.isFinite(expiresAt) || !Number.isFinite(issuedAt)) return false;
  if (expiresAt < now || issuedAt - now > 30_000) return false;

  const secretHash = await sha256BytesBase64(base64ToBytes(backupSecret));
  if (secretHash !== att.backupSecretHash) return false;

  const expected = await hmacBase64(
    backupSecret,
    canonicalReleasePayload({
      version: 'svr2',
      action: 'release_backup_pin_blob',
      userId: att.userId,
      issuedAt: att.issuedAt,
      expiresAt: att.expiresAt,
      nonce: att.nonce,
      backupSecretHash: att.backupSecretHash,
    }),
  );
  return constantTimeEqualBytes(base64ToBytes(expected), base64ToBytes(att.signature));
}

function isPinMode(value: unknown): value is PinMode {
  return typeof value === 'string' && (PIN_MODES as string[]).includes(value);
}

async function derivePinKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const pinBytes = new TextEncoder().encode(pin);
  const baseKey = await hardCrypto.importKey('raw', pinBytes, 'PBKDF2', false, ['deriveKey']);
  return hardCrypto.deriveKey(
    { name: 'PBKDF2', salt: salt as Uint8Array<ArrayBuffer>, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

const PIN_HASH_VERSION_KEY = 'forsure-pin-hash-v';

/** Secure PIN hash using PBKDF2-SHA256 600k iterations (replaces weak SHA-256) */
async function hashPinSecure(pin: string, salt: Uint8Array): Promise<string> {
  const pinBytes = new TextEncoder().encode(pin);
  const baseKey = await hardCrypto.importKey('raw', pinBytes, 'PBKDF2', false, ['deriveBits']);
  const derived = await hardCrypto.deriveBits(
    { name: 'PBKDF2', salt: salt as Uint8Array<ArrayBuffer>, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    256,
  );
  return bytesToBase64(new Uint8Array(derived));
}

/** Legacy SHA-256 hash — used ONLY for migration verification */
async function hashPinLegacy(pin: string, salt: Uint8Array): Promise<string> {
  const pinBytes = new TextEncoder().encode(pin);
  const combined = new Uint8Array(pinBytes.length + salt.length);
  combined.set(pinBytes);
  combined.set(salt, pinBytes.length);
  const hash = await hardCrypto.digest('SHA-256', combined as Uint8Array<ArrayBuffer>);
  return bytesToBase64(new Uint8Array(hash));
}

// ─── Read/write raw keys + full crypto blob helpers ───

async function readRawIdentityBlob(userId: string): Promise<string | null> {
  try {
    const result = await runTxOn('e2ee', 'identity-keys', 'readonly', (store) =>
      reqToPromise<any>(store.get(userId)),
    );
    if (!result) return null;
    return JSON.stringify(result);
  } catch {
    return null;
  }
}

/** Collect ALL crypto material (identity + sessions + ratchet) for PIN wrapping */
async function collectAllCryptoBlob(userId: string): Promise<string | null> {
  const { exportAllSessionKeys, exportAllRatchetStates } = await import('@/lib/crypto');
  const [identityBlob, sessionKeys, ratchetStates] = await Promise.all([
    readRawIdentityBlob(userId),
    exportAllSessionKeys(),
    exportAllRatchetStates(),
  ]);

  if (!identityBlob && sessionKeys.length === 0 && ratchetStates.length === 0) {
    return null;
  }

  if (!identityBlob && (sessionKeys.length > 0 || ratchetStates.length > 0)) {
    throw new Error('Snapshot crypto incomplet: identity absente alors que du matériel crypto existe');
  }

  return JSON.stringify({
    identity: identityBlob ? JSON.parse(identityBlob) : null,
    sessionKeys,
    ratchetStates,
    manifest: {
      hasIdentity: !!identityBlob,
      sessionCount: sessionKeys.length,
      ratchetCount: ratchetStates.length,
    },
    _v: 5,
  });
}

/** Restore ALL crypto material from unwrapped blob */
async function restoreAllCryptoBlob(userId: string, blob: string): Promise<void> {
  const parsed = JSON.parse(blob);
  if (parsed._v === 5 || parsed._v === 4 || parsed._v === 3 || parsed._v === 2) {
    const sessionKeys = Array.isArray(parsed.sessionKeys) ? parsed.sessionKeys : [];
    const ratchetStates = Array.isArray(parsed.ratchetStates) ? parsed.ratchetStates : [];
    const hasIdentity = !!parsed.identity;
    const expectedSessionCount = parsed.manifest?.sessionCount ?? sessionKeys.length;
    const expectedRatchetCount = parsed.manifest?.ratchetCount ?? ratchetStates.length;
    const expectedHasIdentity = parsed.manifest?.hasIdentity ?? hasIdentity;

    if ((sessionKeys.length > 0 || ratchetStates.length > 0) && !hasIdentity) {
      throw new Error('Blob crypto invalide: sessions/ratchets sans identité');
    }

    const {
      importAllSessionKeys,
      importAllRatchetStates,
      exportAllSessionKeys,
      exportAllRatchetStates,
      wipeSessionKeys,
    } = await import('@/lib/crypto');

    try {
      await wipeSessionKeys(userId);

      if (parsed.identity) {
        await writeRawIdentityBlob(userId, JSON.stringify(parsed.identity));
      } else {
        await deleteRawIdentityBlob(userId);
      }

      await importAllSessionKeys(sessionKeys);
      await importAllRatchetStates(ratchetStates);

      const [restoredIdentity, restoredSessionKeys, restoredRatchetStates] = await Promise.all([
        readRawIdentityBlob(userId),
        exportAllSessionKeys(),
        exportAllRatchetStates(),
      ]);

      const identityRestored = !!restoredIdentity;
      if (
        identityRestored !== expectedHasIdentity ||
        restoredSessionKeys.length !== expectedSessionCount ||
        restoredRatchetStates.length !== expectedRatchetCount
      ) {
        throw new Error('Restauration crypto partielle détectée');
      }

      if (identityRestored) {
        const { assertLocalIdentityMatchesServer } = await import('@/lib/crypto/keyManager');
        await assertLocalIdentityMatchesServer(userId);
      }

      console.log('[PIN] All crypto material restored atomically');
    } catch (error) {
      await deleteRawIdentityBlob(userId).catch(() => undefined);
      await wipeSessionKeys(userId).catch(() => undefined);
      throw error;
    }
  } else {
    await writeRawIdentityBlob(userId, blob);
    const { assertLocalIdentityMatchesServer } = await import('@/lib/crypto/keyManager');
    await assertLocalIdentityMatchesServer(userId);
    console.log('[PIN] Identity keys restored (v1 legacy blob)');
  }
}

async function writeRawIdentityBlob(userId: string, blob: string): Promise<void> {
  const parsed = JSON.parse(blob);
  await runTxOn('e2ee', 'identity-keys', 'readwrite', (store) => {
    store.put(parsed);
  });
}

/** Delete raw identity keys from IndexedDB (after PIN wrap) */
async function deleteRawIdentityBlob(userId: string): Promise<void> {
  try {
    await runTxOn('e2ee', 'identity-keys', 'readwrite', (store) => {
      store.delete(userId);
    });
  } catch {
    // DB may not exist yet
  }
}

async function hasUsableRawIdentity(userId: string): Promise<boolean> {
  try {
    const { hasRawIdentityKeys } = await import('@/lib/crypto/keyManager');
    return await hasRawIdentityKeys(userId);
  } catch {
    return false;
  }
}

// ─── Hook ───

export function useChatPin() {
  const { user } = useAuth();
  const [state, setState] = useState<ChatPinState>({
    loaded: false,
    hasPin: false,
    unlocked: false,
    error: null,
    processing: false,
    pinMode: 'every_open',
    restoreRequired: false,
    ...PIN_ATTEMPT_RESET,
    pinReleaseAttestationOk: false,
  });
  const checkedRef = useRef(false);
  const inactivityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinModeRef = useRef<PinMode>('every_open');
  const runtimeWrapKeyRef = useRef<CryptoKey | null>(null);
  const runtimeWrapSaltRef = useRef<string | null>(null);
  const runtimePinRef = useRef<string | null>(null);
  const runtimeBackupSecretRef = useRef<string | null>(null);

  // Fetch PIN mode from DB
  const fetchPinMode = useCallback(async (): Promise<PinMode> => {
    if (!user) return 'every_open';
    try {
      const { data, error } = await supabase.rpc('get_chat_pin_settings' as any);
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return isPinMode((row as any)?.pin_mode) ? (row as any).pin_mode : 'every_open';
    } catch (error) {
      console.warn('[PIN] fetchPinMode fallback:', error);
      return 'every_open';
    }
  }, [user]);

  // Check if user has a PIN and if session is REALLY unlocked
  useEffect(() => {
    if (!user || checkedRef.current) return;
    checkedRef.current = true;

    (async () => {
      try {
        const sessionUnlocked = sessionStorage.getItem(SESSION_KEY) === user.id;
        const [pinResult, modeResult, rawIdentityPresent, wrappedKeys] = await Promise.all([
          supabase.rpc('has_chat_pin', { p_user_id: user.id }),
          fetchPinMode(),
          import('@/lib/crypto/keyManager').then(({ hasRawIdentityKeys }) => hasRawIdentityKeys(user.id)).catch(() => false),
          loadWrappedKeys(user.id),
        ]);

        const hasPin = !!pinResult.data;
        const mode = hasPin ? modeResult : 'every_open';
        pinModeRef.current = mode;

        // IMPORTANT: a sessionStorage flag alone is not enough after refresh.
        // If the raw identity keys are no longer locally restored, messaging must
        // re-lock and ask for the PIN again instead of pretending everything is ready.
        const effectiveUnlock =
          mode === 'every_open'
            ? false
            : sessionUnlocked && hasPin && rawIdentityPresent;

        console.log('[PIN] startup unlock check', {
          userId: user.id,
          sessionUnlocked,
          hasPin,
          rawIdentityPresent,
          wrappedKeysPresent: !!wrappedKeys,
          pinMode: mode,
          effectiveUnlock,
        });

        if (sessionUnlocked && hasPin && !effectiveUnlock) {
          sessionStorage.removeItem(SESSION_KEY);
          window.dispatchEvent(new CustomEvent('forsure-keys-locked'));
          console.warn('[PIN] Cleared stale session unlock flag — crypto keys must be restored before messaging opens');
        }

        setState({
          loaded: true,
          hasPin,
          unlocked: effectiveUnlock,
          error: null,
          processing: false,
          pinMode: mode,
          restoreRequired: hasPin && !rawIdentityPresent,
          ...PIN_ATTEMPT_RESET,
          pinReleaseAttestationOk: false,
        });
      } catch (err) {
        console.error('[PIN] Check failed:', err);
        setState(s => ({ ...s, loaded: true, error: 'Erreur vérification PIN' }));
      }
    })();
  }, [user, fetchPinMode]);

  useEffect(() => {
    if (!user) return;

    const handleKeysUnlocked = async () => {
      try {
        if (!await hasUsableRawIdentity(user.id)) return;
        const mode = await fetchPinMode();
        pinModeRef.current = mode;
        sessionStorage.setItem(SESSION_KEY, user.id);
        setState(s => ({
          ...s,
          loaded: true,
          hasPin: true,
          unlocked: true,
          error: null,
          processing: false,
          pinMode: mode,
          restoreRequired: false,
          ...PIN_ATTEMPT_RESET,
        }));
      } catch (e) {
        console.warn('[PIN] global unlock state refresh failed:', e);
      }
    };

    const handleKeysLocked = () => {
      setState(s => ({
        ...s,
        unlocked: false,
        processing: false,
        restoreRequired: s.hasPin,
        pinReleaseAttestationOk: false,
      }));
    };

    window.addEventListener('forsure-keys-unlocked', handleKeysUnlocked);
    window.addEventListener('forsure-keys-locked', handleKeysLocked);
    return () => {
      window.removeEventListener('forsure-keys-unlocked', handleKeysUnlocked);
      window.removeEventListener('forsure-keys-locked', handleKeysLocked);
    };
  }, [user, fetchPinMode]);

  const lockWithoutWiping = useCallback(async () => {
    sessionStorage.removeItem(SESSION_KEY);

    if (user) {
      try {
        const { wipeSessionKeys } = await import('@/lib/crypto');

        if (runtimeWrapKeyRef.current && runtimeWrapSaltRef.current) {
          const fullBlob = await collectAllCryptoBlob(user.id);
          if (fullBlob) {
            await encryptAndSaveWrappedCrypto(
              user.id,
              runtimeWrapKeyRef.current,
              runtimeWrapSaltRef.current,
              fullBlob,
            );
            console.log('[PIN] Latest crypto snapshot wrapped before lock');
          }
        }

        if (runtimePinRef.current && runtimeBackupSecretRef.current) {
          try {
            const { syncChatPinBackupToServer } = await import('@/lib/crypto/accountKeyBackup');
            await syncChatPinBackupToServer(user.id, runtimePinRef.current, runtimeBackupSecretRef.current);
          } catch (backupErr) {
            console.warn('[PIN] Chat PIN backup refresh before lock failed:', backupErr);
          }
        }

        await deleteRawIdentityBlob(user.id);
        await wipeSessionKeys(user.id);
        window.dispatchEvent(new CustomEvent('forsure-keys-locked'));
        console.log('[PIN] Locked with full local crypto wipe');
      } catch (err) {
        console.warn('[PIN] lockWithoutWiping(): failed to preserve crypto before lock:', err);
      }
    }

    runtimeWrapKeyRef.current = null;
    runtimeWrapSaltRef.current = null;
    runtimePinRef.current = null;
    runtimeBackupSecretRef.current = null;
    setState(s => ({
      ...s,
      unlocked: false,
      restoreRequired: true,
      pinReleaseAttestationOk: false,
    }));
  }, [user]);

  // Handle 'on_return' mode: re-lock when tab loses visibility
  useEffect(() => {
    if (!user || !state.hasPin) return;
    
    const handleVisibility = async () => {
      if (document.hidden && pinModeRef.current === 'on_return' && state.unlocked) {
        await lockWithoutWiping();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [user, state.hasPin, state.unlocked, lockWithoutWiping]);

  // Handle 'on_inactivity' mode: re-lock after 5 min idle
  useEffect(() => {
    if (!user || !state.hasPin || !state.unlocked || pinModeRef.current !== 'on_inactivity') return;

    const resetTimer = () => {
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
      inactivityTimer.current = setTimeout(() => {
        void lockWithoutWiping();
      }, INACTIVITY_TIMEOUT);
    };

    resetTimer();
    const events = ['click', 'keydown', 'touchstart', 'scroll', 'mousemove'] as const;
    events.forEach(e => window.addEventListener(e, resetTimer, { passive: true }));

    return () => {
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
      events.forEach(e => window.removeEventListener(e, resetTimer));
    };
  }, [user, state.hasPin, state.unlocked]);

  /** Update PIN mode */
  const updatePinMode = useCallback(async (mode: PinMode): Promise<boolean> => {
    if (!user) {
      console.warn('[PIN] updatePinMode: no user');
      return false;
    }
    try {
      const { data, error } = await supabase.rpc('update_chat_pin_mode' as any, {
        p_pin_mode: mode,
      });

      if (error) {
        console.error('[PIN] updatePinMode error:', error);
        return false;
      }

      const nextMode = isPinMode(data) ? data : mode;
      pinModeRef.current = nextMode;
      setState(s => ({ ...s, pinMode: nextMode }));
      return true;
    } catch (e) {
      console.error('[PIN] updatePinMode catch:', e);
      return false;
    }
  }, [user]);
  /**
   * Set up a new PIN for the first time.
   */
  const setupPin = useCallback(async (pin: string): Promise<boolean> => {
    if (!user) return false;
    setState(s => ({ ...s, processing: true, error: null }));

    try {
      if (!/^\d{6}$/.test(pin)) {
        setState(s => ({ ...s, processing: false, error: 'Le PIN doit contenir exactement 6 chiffres' }));
        return false;
      }

      const {
        getOrCreateIdentityKeys,
        exportPublicKeyBundle,
        fetchServerIdentityState,
        identityBundleMatchesServer,
      } = await import('@/lib/crypto/keyManager');
      const keys = await getOrCreateIdentityKeys(user.id, { allowCreate: true });
      const publicBundle = await exportPublicKeyBundle(keys);
      const serverIdentity = await fetchServerIdentityState(user.id);
      if (serverIdentity && !identityBundleMatchesServer(publicBundle, serverIdentity)) {
        setState(s => ({
          ...s,
          processing: false,
          error: 'Identite E2EE serveur differente. Restauration obligatoire.',
        }));
        return false;
      }

      // The server PIN must never be created without a local crypto snapshot.
      // Otherwise iOS can show a valid PIN while the E2EE identity is missing.
      const fullBlob = await collectAllCryptoBlob(user.id);
      const identityReady = await hasUsableRawIdentity(user.id);
      if (!fullBlob || !identityReady) {
        setState(s => ({
          ...s,
          processing: false,
          error: 'Impossible de proteger les cles de messagerie. Ouvre la messagerie puis reessaie.',
        }));
        return false;
      }

      const { data: setupResult, error: fnError } = await supabase.functions.invoke('verify-chat-pin', {
        body: { action: 'setup', pin },
      });
      if (fnError || !setupResult?.ok) {
        const errorPayload = fnError ? await readFunctionErrorPayload(fnError) : setupResult;
        setState(s => ({
          ...s,
          processing: false,
          error: errorPayload?.error || setupResult?.error || 'Erreur creation PIN',
          ...pinAttemptStateFromServer(errorPayload),
        }));
        return false;
      }

      const saltB64 = setupResult.salt;
      const backupSecret = typeof setupResult.backupSecret === 'string' ? setupResult.backupSecret : null;
      if (!backupSecret) {
        setState(s => ({ ...s, processing: false, error: 'Erreur creation PIN: secret de sauvegarde absent' }));
        return false;
      }
      if (!await verifyBackupReleaseAttestation(backupSecret, setupResult.releaseAttestation, user.id)) {
        setState(s => ({
          ...s,
          processing: false,
          error: 'Attestation PIN invalide. Restauration refusee.',
          pinReleaseAttestationOk: false,
        }));
        return false;
      }

      const salt = base64ToBytes(saltB64);
      const wrapKey = await derivePinKey(pin, salt);

      runtimeWrapKeyRef.current = wrapKey;
      runtimeWrapSaltRef.current = saltB64;
      runtimePinRef.current = pin;
      runtimeBackupSecretRef.current = backupSecret;

      await encryptAndSaveWrappedCrypto(user.id, wrapKey, saltB64, fullBlob);
      console.log('[PIN] Full crypto blob wrapped (v2)');

      try {
        const { syncChatPinBackupToServer } = await import('@/lib/crypto/accountKeyBackup');
        const synced = await syncChatPinBackupToServer(user.id, pin, backupSecret);
        if (!synced) {
          setState(s => ({
            ...s,
            processing: false,
            error: 'Sauvegarde E2EE impossible. Identite non publiee.',
          }));
          return false;
        }
      } catch (backupErr) {
        console.warn('[PIN] Chat PIN backup setup sync failed:', backupErr);
        setState(s => ({
          ...s,
          processing: false,
          error: 'Sauvegarde E2EE impossible. Identite non publiee.',
        }));
        return false;
      }

      const { error: publishError } = await supabase
        .from('user_public_keys')
        .upsert({
          user_id: user.id,
          identity_key: publicBundle.identityKey,
          signing_key: publicBundle.signingKey,
          fingerprint: publicBundle.fingerprint,
          kem_type: 'X25519',
          is_active: true,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,is_active' });
      if (publishError) {
        setState(s => ({ ...s, processing: false, error: 'Publication des cles E2EE impossible' }));
        return false;
      }

      try {
        const {
          refreshSignedPrekeyIfNeeded,
          refreshDeviceSignedPrekeyIfNeeded,
          refillDeviceOneTimePrekeysIfNeeded,
        } = await import('@/lib/crypto/x3dh');
        const { getCurrentDeviceId, hydrateDeviceId, isDeviceIdTemporary } = await import('@/lib/messaging/currentDevice');
        await refreshSignedPrekeyIfNeeded(user.id, keys.signingPrivateKey);
        const deviceId = await hydrateDeviceId().catch(() => getCurrentDeviceId());
        if (!isDeviceIdTemporary()) {
          await refreshDeviceSignedPrekeyIfNeeded(user.id, deviceId, keys.signingPrivateKey);
          await refillDeviceOneTimePrekeysIfNeeded(user.id, deviceId);
        }
      } catch (spkErr) {
        console.warn('[PIN] X3DH prekey first setup failed:', spkErr);
      }

      sessionStorage.setItem(SESSION_KEY, user.id);
      setState({
        loaded: true,
        hasPin: true,
        unlocked: true,
        error: null,
        processing: false,
        pinMode: 'every_open',
        restoreRequired: false,
        ...PIN_ATTEMPT_RESET,
        pinReleaseAttestationOk: true,
      });
      window.dispatchEvent(new CustomEvent('forsure-keys-unlocked'));
      window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
        detail: { status: 'first_setup', fingerprint: publicBundle.fingerprint },
      }));
      return true;
    } catch (err) {
      console.error('[PIN] Setup failed:', err);
      setState(s => ({ ...s, processing: false, error: 'Erreur création PIN' }));
      return false;
    }
  }, [user]);

  /**
   * Verify PIN and unlock messaging.
   */
  const verifyPin = useCallback(async (pin: string): Promise<boolean> => {
    if (!user) return false;
    setState(s => ({ ...s, processing: true, error: null }));

    try {
      if (!/^\d{6}$/.test(pin)) {
        setState(s => ({ ...s, processing: false, error: 'PIN invalide', pinReleaseAttestationOk: false }));
        return false;
      }

      const { data: verifyResult, error: fnError } = await supabase.functions.invoke('verify-chat-pin', {
        body: { action: 'verify', pin },
      });

      if (fnError) {
        const errorPayload = await readFunctionErrorPayload(fnError);
        setState(s => ({
          ...s,
          processing: false,
          error: errorPayload?.error || 'Erreur serveur',
          ...pinAttemptStateFromServer(errorPayload),
          pinReleaseAttestationOk: false,
        }));
        return false;
      }

      if (!verifyResult?.ok) {
        setState(s => ({
          ...s,
          processing: false,
          error: verifyResult?.error || 'PIN incorrect',
          ...pinAttemptStateFromServer(verifyResult),
          pinReleaseAttestationOk: false,
        }));
        return false;
      }

      let cryptoReady = false;
      const backupSecret = typeof verifyResult.backupSecret === 'string' ? verifyResult.backupSecret : null;
      if (backupSecret && !await verifyBackupReleaseAttestation(backupSecret, verifyResult.releaseAttestation, user.id)) {
        setState(s => ({
          ...s,
          processing: false,
          error: 'Attestation PIN invalide. Restauration refusee.',
          pinReleaseAttestationOk: false,
        }));
        return false;
      }
      runtimePinRef.current = pin;
      runtimeBackupSecretRef.current = backupSecret;

      let wrapped = await loadWrappedKeys(user.id);
      if (!wrapped && backupSecret) {
        try {
          const { restoreWithChatPinBackup } = await import('@/lib/crypto/accountKeyBackup');
          const restoreStatus = await restoreWithChatPinBackup(user.id, pin, backupSecret);
          if (restoreStatus === 'restored' || restoreStatus === 'local_ok') {
            wrapped = await loadWrappedKeys(user.id);
            if (!wrapped && await hasUsableRawIdentity(user.id)) {
              cryptoReady = true;
              console.log('[PIN] Keys restored from chat PIN server backup');
            }
          } else if (restoreStatus === 'error') {
            console.warn('[PIN] Chat PIN server backup restore errored');
          }
        } catch (restoreErr) {
          console.warn('[PIN] Chat PIN server backup restore failed:', restoreErr);
        }
      }

      if (wrapped) {
        try {
          const wrapKey = await derivePinKey(pin, base64ToBytes(wrapped.salt));
          runtimeWrapKeyRef.current = wrapKey;
          runtimeWrapSaltRef.current = wrapped.salt;
          const cipherBytes = base64ToBytes(wrapped.wrappedBlob);
          const iv = base64ToBytes(wrapped.iv);
          const plainBuffer = await hardCrypto.decrypt(
            { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer> },
            wrapKey,
            cipherBytes as Uint8Array<ArrayBuffer>,
          );
          const rawBlob = new TextDecoder().decode(plainBuffer);
          await restoreAllCryptoBlob(user.id, rawBlob);
          cryptoReady = await hasUsableRawIdentity(user.id);
          if (!cryptoReady) {
            throw new Error('PIN blob restored without identity keys');
          }
          console.log('[PIN] All keys unwrapped and restored');
        } catch (unwrapErr) {
          console.warn('[PIN] Key unwrap failed:', unwrapErr);
          setState(s => ({
            ...s,
            processing: false,
            error: 'Restauration crypto incomplète — veuillez réessayer',
            restoreRequired: true,
          }));
          return false;
        }
      } else if (!cryptoReady && verifyResult.salt) {
        try {
          const fullBlob = await collectAllCryptoBlob(user.id);
          const identityReady = await hasUsableRawIdentity(user.id);
          if (!fullBlob || !identityReady) {
            setState(s => ({
              ...s,
              processing: false,
              error: 'PIN valide, mais aucune sauvegarde web n a pu restaurer tes cles. Lie ce device depuis un appareil connecte ou utilise la cle de recuperation.',
              restoreRequired: true,
            }));
            return false;
          }

          const salt = base64ToBytes(verifyResult.salt);
          const wrapKey = await derivePinKey(pin, salt);
          runtimeWrapKeyRef.current = wrapKey;
          runtimeWrapSaltRef.current = verifyResult.salt;
          await encryptAndSaveWrappedCrypto(user.id, wrapKey, verifyResult.salt, fullBlob);
          cryptoReady = true;
          console.log('[PIN] Full crypto blob wrapped on first verify (v2)');
        } catch (rewrapErr) {
          console.warn('[PIN] First verify rewrap failed:', rewrapErr);
          setState(s => ({
            ...s,
            processing: false,
            error: 'PIN valide, mais restauration crypto impossible sur ce device.',
            restoreRequired: true,
          }));
          return false;
        }
      }

      if (!cryptoReady) {
        sessionStorage.removeItem(SESSION_KEY);
        window.dispatchEvent(new CustomEvent('forsure-keys-locked'));
        setState(s => ({
          ...s,
          processing: false,
          error: 'PIN valide, mais aucune cle E2EE locale n a ete restauree.',
          restoreRequired: true,
        }));
        return false;
      }

      try {
        sessionStorage.setItem(
          `forsure:e2ee-resync-pending:${user.id}`,
          JSON.stringify({ at: Date.now(), detail: { status: 'pin_unlocked' } }),
        );
      } catch {}
      sessionStorage.setItem(SESSION_KEY, user.id);
      window.dispatchEvent(new CustomEvent('forsure-keys-unlocked'));

      let resyncOk = false;
      try {
        const { resyncE2EE } = await import('@/lib/crypto/resyncE2EE');
        const report = await resyncE2EE(user.id);
        resyncOk = report.steps.identity === 'ok' && !report.needsPinUnlock;
        if (!resyncOk) {
          console.warn('[PIN] Post-unlock E2EE resync incomplete:', report);
        }
      } catch (resyncErr) {
        console.warn('[PIN] Post-unlock E2EE resync failed:', resyncErr);
      }

      if (backupSecret) {
        try {
          const { syncChatPinBackupToServer } = await import('@/lib/crypto/accountKeyBackup');
          await syncChatPinBackupToServer(user.id, pin, backupSecret);
        } catch (backupErr) {
          console.warn('[PIN] Chat PIN backup refresh after unlock failed:', backupErr);
        }
      }

      const mode = await fetchPinMode();
      pinModeRef.current = mode;

      setState({
        loaded: true,
        hasPin: true,
        unlocked: true,
        error: null,
        processing: false,
        pinMode: mode,
        restoreRequired: false,
        ...PIN_ATTEMPT_RESET,
        pinReleaseAttestationOk: !!backupSecret,
      });

      try {
        sessionStorage.removeItem(`forsure:e2ee-pin-unlock-required:${user.id}`);
        if (resyncOk) {
          sessionStorage.setItem(`forsure:e2ee-resync-done:${user.id}`, String(Date.now()));
          sessionStorage.removeItem(`forsure:e2ee-resync-pending:${user.id}`);
        }
      } catch {}
      window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
        detail: { status: 'pin_unlocked', resynced: resyncOk },
      }));

      return true;
    } catch (err) {
      console.error('[PIN] Verify failed:', err);
      setState(s => ({ ...s, processing: false, error: 'Erreur vérification' }));
      return false;
    }
  }, [user, fetchPinMode]);

  /** Lock messaging — non-destructive lock preserving session keys and ratchet state. */
  const lock = useCallback(async () => {
    await lockWithoutWiping();
  }, [lockWithoutWiping]);

  /** Request PIN reset via email OTP */
  const requestReset = useCallback(async (): Promise<boolean> => {
    if (!user) return false;
    setState(s => ({ ...s, processing: true, error: null }));
    try {
      const { data, error } = await supabase.functions.invoke('verify-chat-pin', {
        body: { action: 'request-reset' },
      });
      if (error || !data?.ok) {
        const errorPayload = error ? await readFunctionErrorPayload(error) : data;
        setState(s => ({
          ...s,
          processing: false,
          error: errorPayload?.error || data?.error || 'Erreur envoi email',
          ...pinAttemptStateFromServer(errorPayload),
        }));
        return false;
      }
      setState(s => ({ ...s, processing: false }));
      return true;
    } catch {
      setState(s => ({ ...s, processing: false, error: 'Erreur envoi email' }));
      return false;
    }
  }, [user]);

  /** Confirm PIN reset with email OTP code */
  const confirmReset = useCallback(async (code: string): Promise<boolean> => {
    if (!user) return false;
    setState(s => ({ ...s, processing: true, error: null }));
    try {
      const { data, error } = await supabase.functions.invoke('verify-chat-pin', {
        body: { action: 'confirm-reset', code },
      });
      if (error || !data?.ok) {
        const errorPayload = error ? await readFunctionErrorPayload(error) : data;
        setState(s => ({
          ...s,
          processing: false,
          error: errorPayload?.error || data?.error || 'Code incorrect',
          ...pinAttemptStateFromServer(errorPayload),
        }));
        return false;
      }
      sessionStorage.removeItem(SESSION_KEY);
      setState({
        loaded: true,
        hasPin: false,
        unlocked: false,
        error: null,
        processing: false,
        pinMode: 'every_open',
        restoreRequired: false,
        ...PIN_ATTEMPT_RESET,
        pinReleaseAttestationOk: false,
      });
      return true;
    } catch {
      setState(s => ({ ...s, processing: false, error: 'Erreur vérification' }));
      return false;
    }
  }, [user]);

  return {
    ...state,
    setupPin,
    verifyPin,
    lock,
    requestReset,
    confirmReset,
    updatePinMode,
  };
}
