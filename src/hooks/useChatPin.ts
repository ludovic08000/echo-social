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
import { openE2EEDB } from '@/lib/crypto/indexedDb';

export type PinMode = 'every_open' | 'once_per_session' | 'on_inactivity' | 'on_return';

const SESSION_KEY = 'forsure-pin-unlocked';
const PIN_WRAP_DB = 'forsure-pin-wrap';
// CRITICAL: Bumped to v2 to add the unified store. v1 used a single store
// "wrapped-keys" which was incompatible with pinWrap.ts ("pin-wrapped-keys").
// We keep BOTH stores in v2 so we can migrate legacy blobs lazily.
const PIN_WRAP_VERSION = 2;
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
}

// ─── IndexedDB for wrapped keys ───

function openPinDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PIN_WRAP_DB, PIN_WRAP_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Unified store (matches pinWrap.ts)
      if (!db.objectStoreNames.contains(PIN_WRAP_STORE)) {
        db.createObjectStore(PIN_WRAP_STORE, { keyPath: 'id' });
      }
      // Legacy store kept for one-shot migration (do NOT drop yet — older
      // builds may still write here during the upgrade window).
      if (!db.objectStoreNames.contains(PIN_WRAP_LEGACY_STORE)) {
        db.createObjectStore(PIN_WRAP_LEGACY_STORE, { keyPath: 'id' });
      }
    };
  });
}

async function saveWrappedKeys(userId: string, data: {
  wrappedBlob: string;
  iv: string;
  salt: string;
}) {
  const db = await openPinDB();
  const tx = db.transaction(PIN_WRAP_STORE, 'readwrite');
  // Persist using BOTH the useChatPin schema and the pinWrap.ts schema
  // so any reader (KeyBackupPanel, accountKeyBackup, resyncE2EE) can decode it.
  tx.objectStore(PIN_WRAP_STORE).put({
    id: userId,
    // useChatPin shape
    wrappedBlob: data.wrappedBlob,
    iv: data.iv,
    salt: data.salt,
    // pinWrap.ts compatibility shape
    ciphertext: data.wrappedBlob,
    version: 1,
  });
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
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
    const db = await openPinDB();

    // 1) Try unified store first
    const fromUnified = await new Promise<any>((resolve, reject) => {
      const tx = db.transaction(PIN_WRAP_STORE, 'readonly');
      const req = tx.objectStore(PIN_WRAP_STORE).get(userId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    if (fromUnified) {
      // Accept either useChatPin shape or pinWrap.ts shape
      const wrappedBlob = fromUnified.wrappedBlob ?? fromUnified.ciphertext;
      if (wrappedBlob && fromUnified.iv && fromUnified.salt) {
        return { wrappedBlob, iv: fromUnified.iv, salt: fromUnified.salt };
      }
    }

    // 2) Legacy fallback — migrate to unified store on the fly
    const fromLegacy = await new Promise<any>((resolve, reject) => {
      try {
        const tx = db.transaction(PIN_WRAP_LEGACY_STORE, 'readonly');
        const req = tx.objectStore(PIN_WRAP_LEGACY_STORE).get(userId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } catch (e) {
        resolve(null);
      }
    }).catch(() => null);

    if (fromLegacy?.wrappedBlob && fromLegacy.iv && fromLegacy.salt) {
      console.warn('[PIN] migrating legacy wrapped-keys → pin-wrapped-keys');
      await saveWrappedKeys(userId, {
        wrappedBlob: fromLegacy.wrappedBlob,
        iv: fromLegacy.iv,
        salt: fromLegacy.salt,
      });
      // Best-effort cleanup of legacy entry
      try {
        const tx = db.transaction(PIN_WRAP_LEGACY_STORE, 'readwrite');
        tx.objectStore(PIN_WRAP_LEGACY_STORE).delete(userId);
      } catch {}
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
    const db = await openE2EEDB();
    if (!db.objectStoreNames.contains('identity-keys')) return null;
    const tx = db.transaction('identity-keys', 'readonly');
    const req = tx.objectStore('identity-keys').get(userId);
    const result = await new Promise<any>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
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
  const db = await openE2EEDB();
  const tx = db.transaction('identity-keys', 'readwrite');
  tx.objectStore('identity-keys').put(parsed);
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Delete raw identity keys from IndexedDB (after PIN wrap) */
async function deleteRawIdentityBlob(userId: string): Promise<void> {
  try {
    const db = await openE2EEDB();
    if (!db.objectStoreNames.contains('identity-keys')) return;
    const tx = db.transaction('identity-keys', 'readwrite');
    tx.objectStore('identity-keys').delete(userId);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
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
        });
      } catch (err) {
        console.error('[PIN] Check failed:', err);
        setState(s => ({ ...s, loaded: true, error: 'Erreur vérification PIN' }));
      }
    })();
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
    setState(s => ({ ...s, unlocked: false }));
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
        setState(s => ({ ...s, processing: false, error: setupResult?.error || 'Erreur création PIN' }));
        return false;
      }

      const saltB64 = setupResult.salt;
      const backupSecret = typeof setupResult.backupSecret === 'string' ? setupResult.backupSecret : null;
      if (!backupSecret) {
        setState(s => ({ ...s, processing: false, error: 'Erreur creation PIN: secret de sauvegarde absent' }));
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
        setState(s => ({ ...s, processing: false, error: 'PIN invalide' }));
        return false;
      }

      const { data: verifyResult, error: fnError } = await supabase.functions.invoke('verify-chat-pin', {
        body: { action: 'verify', pin },
      });

      if (fnError) {
        setState(s => ({ ...s, processing: false, error: 'Erreur serveur' }));
        return false;
      }

      if (!verifyResult?.ok) {
        setState(s => ({ ...s, processing: false, error: verifyResult?.error || 'PIN incorrect' }));
        return false;
      }

      let cryptoReady = false;
      const backupSecret = typeof verifyResult.backupSecret === 'string' ? verifyResult.backupSecret : null;
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
        }));
        return false;
      }

      try {
        sessionStorage.setItem(
          `forsure:e2ee-resync-pending:${user.id}`,
          JSON.stringify({ at: Date.now(), detail: { status: 'pin_unlocked' } }),
        );
      } catch {}
      window.dispatchEvent(new CustomEvent('forsure-keys-unlocked'));
      window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
        detail: { status: 'pin_unlocked' },
      }));

      if (backupSecret) {
        try {
          const { syncChatPinBackupToServer } = await import('@/lib/crypto/accountKeyBackup');
          await syncChatPinBackupToServer(user.id, pin, backupSecret);
        } catch (backupErr) {
          console.warn('[PIN] Chat PIN backup refresh after unlock failed:', backupErr);
        }
      }

      sessionStorage.setItem(SESSION_KEY, user.id);
      const mode = await fetchPinMode();
      pinModeRef.current = mode;

      setState({
        loaded: true,
        hasPin: true,
        unlocked: true,
        error: null,
        processing: false,
        pinMode: mode,
      });

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
        setState(s => ({ ...s, processing: false, error: data?.error || 'Erreur envoi email' }));
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
        setState(s => ({ ...s, processing: false, error: data?.error || 'Code incorrect' }));
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
