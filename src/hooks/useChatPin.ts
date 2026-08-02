/**
 * Aegis messaging PIN gate.
 *
 * The PIN itself never leaves the device. Supabase stores only a salt and the
 * Aegis master key wrapped by a key derived from that PIN. This lets a browser
 * recover the gate after cache loss without exposing the PIN or ratchet state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { hardCrypto, hardGlobals } from '@/lib/crypto/cryptoIntegrity';
import { loadIdentityKeys } from '@/lib/crypto/keyManager';
import { reqToPromise, runTxOn } from '@/lib/crypto/indexedDbTx';
import {
  isSecureStoreNative,
  secureGetSecret,
  secureRemoveSecret,
  secureSetSecret,
} from '@/lib/secureStore';
import { restoreWithBackupPin } from '@/lib/crypto/accountKeyBackup';
import { setupPersistentBackupPin } from '@/lib/crypto/aegisPinBackup';

export type PinMode = 'every_open' | 'once_per_session' | 'on_inactivity' | 'on_return';

export interface ChatPinState {
  loaded: boolean;
  hasPin: boolean;
  unlocked: boolean;
  error: string | null;
  processing: boolean;
  pinMode: PinMode;
}

interface LocalPinRecord {
  id: string;
  version: 3;
  salt: string;
  iv: string;
  wrappedBlob: string;
  createdAt: number;
}

interface ServerContinuityInspection {
  complete: boolean;
  serverHasPin: boolean;
  activeFingerprint: string | null;
  hasAccountBackup: boolean;
}

interface SetupSafety {
  allowed: boolean;
  serverHasPin: boolean;
  continuityExists: boolean;
  reason:
    | 'safe_first_setup'
    | 'safe_restored_identity'
    | 'server_pin_exists'
    | 'restore_required'
    | 'inspection_unavailable';
}

const STORE = 'pin-verifiers';
const SESSION_KEY = 'forsure-pin-unlocked';
const MODE_PREFIX = 'forsure-pin-mode:';
const SECURE_PIN_PREFIX = 'forsure-chat-pin-verifier:';
const PIN_STATE_CHANGED_EVENT = 'forsure:chat-pin-state-changed';
const PIN_VERSION = 3;
const PBKDF2_ITERATIONS = 600_000;
const INACTIVITY_TIMEOUT = 5 * 60_000;
const VERIFIER_PREFIX = 'FORSURE-LOCAL-PIN-v3|';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return hardGlobals.btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = hardGlobals.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function storageGet(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // Web Storage is optional. IndexedDB/Keychain remains authoritative.
  }
}

function storageRemove(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Best-effort lock mode/session metadata cleanup.
  }
}

function localMode(userId: string): PinMode {
  const value = storageGet(localStorage, `${MODE_PREFIX}${userId}`);
  return value === 'once_per_session' || value === 'on_inactivity' || value === 'on_return'
    ? value
    : 'every_open';
}

async function derivePinKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await hardCrypto.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return hardCrypto.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as Uint8Array<ArrayBuffer>,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function pinAad(userId: string): Uint8Array {
  return new TextEncoder().encode(`${VERIFIER_PREFIX}${userId}`);
}

async function loadLocalPin(userId: string): Promise<LocalPinRecord | null> {
  const value = await runTxOn('pin-wrap', [STORE], 'readonly', (tx) =>
    reqToPromise(tx.objectStore(STORE).get(userId)),
  ).catch(() => null) as Partial<LocalPinRecord> | null;

  const isValidRecord = (candidate: Partial<LocalPinRecord> | null): candidate is LocalPinRecord => (
    Boolean(candidate) &&
    candidate?.id === userId &&
    candidate?.version === PIN_VERSION &&
    typeof candidate?.salt === 'string' &&
    typeof candidate?.iv === 'string' &&
    typeof candidate?.wrappedBlob === 'string'
  );

  if (isValidRecord(value)) return value;

  // Native apps recover the encrypted verifier from Keychain/Keystore when
  // WebView/IndexedDB storage was purged. The PIN itself is never stored.
  if (isSecureStoreNative()) {
    const encoded = await secureGetSecret(`${SECURE_PIN_PREFIX}${userId}`).catch(() => null);
    if (encoded) {
      try {
        const restored = JSON.parse(encoded) as Partial<LocalPinRecord>;
        if (isValidRecord(restored)) {
          await runTxOn('pin-wrap', [STORE], 'readwrite', (tx) => {
            tx.objectStore(STORE).put(restored);
          });
          return restored;
        }
      } catch {
        // Invalid native record is treated as absent, never as a valid PIN.
      }
    }
  }
  return null;
}

async function saveLocalPin(userId: string, pin: string): Promise<void> {
  const salt = hardCrypto.getRandomValues(new Uint8Array(32));
  const iv = hardCrypto.getRandomValues(new Uint8Array(12));
  const key = await derivePinKey(pin, salt);
  const ciphertext = await hardCrypto.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as Uint8Array<ArrayBuffer>,
      additionalData: pinAad(userId) as Uint8Array<ArrayBuffer>,
      tagLength: 128,
    },
    key,
    new TextEncoder().encode(`${VERIFIER_PREFIX}${userId}`),
  );
  const record: LocalPinRecord = {
    id: userId,
    version: PIN_VERSION,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    wrappedBlob: bytesToBase64(new Uint8Array(ciphertext)),
    createdAt: Date.now(),
  };
  await runTxOn('pin-wrap', [STORE], 'readwrite', (tx) => {
    tx.objectStore(STORE).put(record);
  });

  const persisted = await runTxOn('pin-wrap', [STORE], 'readonly', (tx) =>
    reqToPromise(tx.objectStore(STORE).get(userId)),
  ) as Partial<LocalPinRecord> | undefined;
  if (persisted?.version !== PIN_VERSION || persisted.wrappedBlob !== record.wrappedBlob) {
    throw new Error('PIN_PERSISTENCE_READBACK_FAILED');
  }

  if (isSecureStoreNative()) {
    const mirrored = await secureSetSecret(
      `${SECURE_PIN_PREFIX}${userId}`,
      JSON.stringify(record),
    );
    if (!mirrored) {
      console.warn('[LOCAL-PIN] native secure mirror unavailable; IndexedDB remains active');
    }
  }
}

async function removeLocalPin(userId: string): Promise<void> {
  await runTxOn('pin-wrap', [STORE], 'readwrite', (tx) => {
    tx.objectStore(STORE).delete(userId);
  });
  if (isSecureStoreNative()) {
    await secureRemoveSecret(`${SECURE_PIN_PREFIX}${userId}`);
  }
}

async function verifyLocalPin(userId: string, pin: string): Promise<boolean> {
  const record = await loadLocalPin(userId);
  if (!record) return false;
  try {
    const key = await derivePinKey(pin, base64ToBytes(record.salt));
    const plaintext = await hardCrypto.decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToBytes(record.iv) as Uint8Array<ArrayBuffer>,
        additionalData: pinAad(userId) as Uint8Array<ArrayBuffer>,
        tagLength: 128,
      },
      key,
      base64ToBytes(record.wrappedBlob) as Uint8Array<ArrayBuffer>,
    );
    return new TextDecoder().decode(plaintext) === `${VERIFIER_PREFIX}${userId}`;
  } catch {
    return false;
  }
}

/**
 * Inspect all server-side continuity markers as one decision. A transport/RLS
 * failure is not equivalent to "this is a new account"; uncertainty therefore
 * keeps setup closed until the inspection can be repeated safely.
 */
async function inspectServerContinuity(userId: string): Promise<ServerContinuityInspection> {
  const [pinResult, identityResult, backupResult] = await Promise.all([
    supabase.rpc('has_backup_pin' as never, { _user_id: userId } as never),
    supabase
      .from('user_public_keys')
      .select('fingerprint')
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle(),
    supabase
      .from('user_backups')
      .select('id')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle(),
  ]);

  return {
    complete: !pinResult.error && !identityResult.error && !backupResult.error,
    serverHasPin: !pinResult.error && pinResult.data === true,
    activeFingerprint: identityResult.error ? null : identityResult.data?.fingerprint ?? null,
    hasAccountBackup: !backupResult.error && Boolean(backupResult.data?.id),
  };
}

async function inspectSetupSafety(userId: string): Promise<SetupSafety> {
  let inspection: ServerContinuityInspection;
  try {
    inspection = await inspectServerContinuity(userId);
  } catch {
    return {
      allowed: false,
      serverHasPin: false,
      continuityExists: true,
      reason: 'inspection_unavailable',
    };
  }

  const localIdentity = await loadIdentityKeys(userId).catch(() => null);
  const continuityExists = Boolean(
    inspection.serverHasPin ||
    inspection.activeFingerprint ||
    inspection.hasAccountBackup,
  );

  if (inspection.serverHasPin) {
    return {
      allowed: false,
      serverHasPin: true,
      continuityExists: true,
      reason: 'server_pin_exists',
    };
  }

  if (!inspection.complete) {
    return {
      allowed: false,
      serverHasPin: false,
      continuityExists: true,
      reason: 'inspection_unavailable',
    };
  }

  if (!continuityExists) {
    return {
      allowed: true,
      serverHasPin: false,
      continuityExists: false,
      reason: 'safe_first_setup',
    };
  }

  const restoredIdentityMatches = Boolean(
    localIdentity &&
    inspection.activeFingerprint &&
    localIdentity.fingerprint === inspection.activeFingerprint,
  );
  if (restoredIdentityMatches) {
    return {
      allowed: true,
      serverHasPin: false,
      continuityExists: true,
      reason: 'safe_restored_identity',
    };
  }

  return {
    allowed: false,
    serverHasPin: false,
    continuityExists: true,
    reason: 'restore_required',
  };
}

function announceUnlock(userId: string): void {
  storageSet(sessionStorage, SESSION_KEY, userId);
  window.dispatchEvent(new CustomEvent('forsure-keys-unlocked'));
  window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
    detail: { reason: 'local_pin_unlocked' },
  }));
  window.dispatchEvent(new CustomEvent(PIN_STATE_CHANGED_EVENT, {
    detail: { userId, unlocked: true },
  }));
}

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
  const inactivityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinModeRef = useRef<PinMode>('every_open');

  useEffect(() => {
    let cancelled = false;
    if (!user?.id) {
      setState((current) => ({ ...current, loaded: true, hasPin: false, unlocked: false }));
      return;
    }

    const refresh = async (unlockCurrentOpen = false) => {
      const record = await loadLocalPin(user.id);
      const safety = record
        ? null
        : await inspectSetupSafety(user.id);
      if (cancelled) return;

      const mode = localMode(user.id);
      const sessionUnlocked = storageGet(sessionStorage, SESSION_KEY) === user.id;
      // Recovery/uncertain states deliberately use the PIN-entry side of the
      // gate. Only a proven first setup or a matching restored identity may
      // display the PIN-creation screen.
      const hasPin = Boolean(record) || Boolean(safety && !safety.allowed);
      const unlocked = Boolean(record) && (
        unlockCurrentOpen || (mode !== 'every_open' && sessionUnlocked)
      );
      const recoveryError = !record && safety?.reason === 'restore_required'
        ? 'Restaurez votre identité sécurisée existante avant de créer un nouveau PIN.'
        : !record && safety?.reason === 'inspection_unavailable'
          ? 'Vérification de sécurité indisponible. Réessayez après la restauration du compte.'
          : null;

      pinModeRef.current = mode;
      setState({
        loaded: true,
        hasPin,
        unlocked,
        error: recoveryError,
        processing: false,
        pinMode: mode,
      });
    };

    void refresh();
    const onPinStateChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: string; unlocked?: boolean }>).detail;
      if (!detail?.userId || detail.userId === user.id) void refresh(detail?.unlocked === true);
    };
    const onKeysRestored = () => void refresh(false);

    window.addEventListener(PIN_STATE_CHANGED_EVENT, onPinStateChanged);
    window.addEventListener('forsure-keys-restored', onKeysRestored);
    window.addEventListener('forsure:e2ee-unlocked', onKeysRestored);
    window.addEventListener('forsure-e2ee-identity-ready', onKeysRestored);

    return () => {
      cancelled = true;
      window.removeEventListener(PIN_STATE_CHANGED_EVENT, onPinStateChanged);
      window.removeEventListener('forsure-keys-restored', onKeysRestored);
      window.removeEventListener('forsure:e2ee-unlocked', onKeysRestored);
      window.removeEventListener('forsure-e2ee-identity-ready', onKeysRestored);
    };
  }, [user?.id]);

  const lock = useCallback(async () => {
    storageRemove(sessionStorage, SESSION_KEY);
    setState((current) => ({ ...current, unlocked: false }));
    window.dispatchEvent(new CustomEvent('forsure-messaging-locked'));
    if (user?.id) {
      window.dispatchEvent(new CustomEvent(PIN_STATE_CHANGED_EVENT, {
        detail: { userId: user.id, unlocked: false },
      }));
    }
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id || !state.hasPin || !state.unlocked) return;
    const onVisibility = () => {
      if (document.hidden && pinModeRef.current === 'on_return') void lock();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [lock, state.hasPin, state.unlocked, user?.id]);

  useEffect(() => {
    if (!user?.id || !state.hasPin || !state.unlocked || pinModeRef.current !== 'on_inactivity') return;
    const reset = () => {
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
      inactivityTimer.current = setTimeout(() => void lock(), INACTIVITY_TIMEOUT);
    };
    const events = ['click', 'keydown', 'touchstart', 'scroll'] as const;
    reset();
    events.forEach((event) => window.addEventListener(event, reset, { passive: true }));
    return () => {
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
      events.forEach((event) => window.removeEventListener(event, reset));
    };
  }, [lock, state.hasPin, state.unlocked, user?.id]);

  const setupPin = useCallback(async (pin: string): Promise<boolean> => {
    if (!user?.id) return false;
    if (!/^\d{6}$/.test(pin)) {
      setState((current) => ({ ...current, error: 'Le PIN doit contenir exactement 6 chiffres' }));
      return false;
    }
    setState((current) => ({ ...current, processing: true, error: null }));

    try {
      // Re-run the continuity proof at the mutation boundary. A stale render or
      // a concurrent restore must never turn the setup screen into an identity
      // reset primitive.
      const safety = await inspectSetupSafety(user.id);
      if (!safety.allowed) {
        const error = safety.reason === 'server_pin_exists'
          ? 'Un PIN existe déjà pour ce compte. Entrez votre PIN existant.'
          : safety.reason === 'inspection_unavailable'
            ? 'Vérification de sécurité indisponible. Aucun nouveau PIN n’a été créé.'
            : 'Restaurez votre identité sécurisée existante avant de créer un nouveau PIN.';
        setState((current) => ({ ...current, processing: false, hasPin: true, error }));
        return false;
      }

      await saveLocalPin(user.id, pin);
      announceUnlock(user.id);
      pinModeRef.current = 'every_open';
      storageSet(localStorage, `${MODE_PREFIX}${user.id}`, 'every_open');
      setState({
        loaded: true,
        hasPin: true,
        unlocked: true,
        error: null,
        processing: false,
        pinMode: 'every_open',
      });

      void setupPersistentBackupPin(pin, user.id)
        .then((result) => {
          if (result !== 'ok') {
            console.warn('[LOCAL-PIN] initial server backup deferred', { result });
          }
        })
        .catch((error) => {
          console.warn('[LOCAL-PIN] initial server backup failed', error);
        });

      // This creates only an email-reset ticket. The PIN itself is deliberately
      // absent from the request and cannot be verified by the server.
      void supabase.functions.invoke('verify-chat-pin', {
        body: { action: 'register-local-recovery' },
      }).catch(() => undefined);
      return true;
    } catch (error) {
      console.warn('[LOCAL-PIN] setup failed', error);
      setState((current) => ({ ...current, processing: false, error: 'Stockage local indisponible' }));
      return false;
    }
  }, [user?.id]);

  const verifyPin = useCallback(async (pin: string): Promise<boolean> => {
    if (!user?.id) return false;
    if (!/^\d{6}$/.test(pin)) {
      setState((current) => ({ ...current, error: 'PIN invalide' }));
      return false;
    }
    setState((current) => ({ ...current, processing: true, error: null }));

    const localRecord = await loadLocalPin(user.id);
    if (localRecord) {
      const valid = await verifyLocalPin(user.id, pin);
      if (!valid) {
        setState((current) => ({ ...current, processing: false, error: 'PIN incorrect' }));
        return false;
      }
      announceUnlock(user.id);
      setState((current) => ({
        ...current,
        unlocked: true,
        processing: false,
        error: null,
      }));
      void setupPersistentBackupPin(pin, user.id)
        .then((result) => {
          if (result !== 'ok') {
            console.warn('[LOCAL-PIN] background server backup upgrade deferred', { result });
          }
        })
        .catch((error) => {
          console.warn('[LOCAL-PIN] background server backup upgrade failed', error);
        });
      return true;
    }

    const restored = await restoreWithBackupPin(pin, user.id);
    if (restored.status !== 'restored') {
      const error = restored.status === 'locked'
        ? 'Trop de tentatives. Réessayez plus tard.'
        : restored.status === 'wrong_pin'
          ? 'PIN incorrect'
          : restored.status === 'no_backup'
            ? 'Aucune sauvegarde PIN utilisable. Reconnectez-vous avec votre mot de passe pour restaurer l’identité.'
            : 'Sauvegarde PIN Aegis indisponible';
      setState((current) => ({ ...current, processing: false, error }));
      return false;
    }

    await saveLocalPin(user.id, pin);
    announceUnlock(user.id);
    setState((current) => ({ ...current, hasPin: true, unlocked: true, processing: false, error: null }));
    return true;
  }, [user?.id]);

  const updatePinMode = useCallback(async (mode: PinMode): Promise<boolean> => {
    if (!user?.id) return false;
    storageSet(localStorage, `${MODE_PREFIX}${user.id}`, mode);
    pinModeRef.current = mode;
    setState((current) => ({ ...current, pinMode: mode }));
    window.dispatchEvent(new CustomEvent(PIN_STATE_CHANGED_EVENT, {
      detail: { userId: user.id, unlocked: true },
    }));
    return true;
  }, [user?.id]);

  const requestReset = useCallback(async (): Promise<boolean> => {
    if (!user?.id) return false;
    setState((current) => ({ ...current, processing: true, error: null }));
    const { data, error } = await supabase.functions.invoke('verify-chat-pin', {
      body: { action: 'request-reset' },
    });
    const ok = !error && data?.ok === true;
    setState((current) => ({
      ...current,
      processing: false,
      error: ok ? null : data?.error ?? 'Erreur envoi email',
    }));
    return ok;
  }, [user?.id]);

  const confirmReset = useCallback(async (code: string): Promise<boolean> => {
    if (!user?.id) return false;
    setState((current) => ({ ...current, processing: true, error: null }));
    const { data, error } = await supabase.functions.invoke('verify-chat-pin', {
      body: { action: 'confirm-reset', code },
    });
    if (error || data?.ok !== true) {
      setState((current) => ({
        ...current,
        processing: false,
        error: data?.error ?? 'Code incorrect',
      }));
      return false;
    }
    await removeLocalPin(user.id);
    storageRemove(sessionStorage, SESSION_KEY);
    storageRemove(localStorage, `${MODE_PREFIX}${user.id}`);
    pinModeRef.current = 'every_open';
    setState({
      loaded: true,
      hasPin: false,
      unlocked: false,
      error: null,
      processing: false,
      pinMode: 'every_open',
    });
    window.dispatchEvent(new CustomEvent(PIN_STATE_CHANGED_EVENT, {
      detail: { userId: user.id, unlocked: false },
    }));
    return true;
  }, [user?.id]);

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

export const __test__ = {
  loadLocalPin,
  saveLocalPin,
  verifyLocalPin,
  removeLocalPin,
  inspectServerContinuity,
  inspectSetupSafety,
};
