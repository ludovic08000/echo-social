/**
 * Local messaging PIN gate.
 *
 * The PIN never leaves this device and never encrypts, deletes or restores a
 * Double Ratchet state. It protects access to the messaging UI; the account
 * password and Aegis Vault remain the recovery mechanism for E2EE material.
 * Keeping those responsibilities separate prevents a UI lock from advancing
 * or destroying a cryptographic session.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { hardCrypto, hardGlobals } from '@/lib/crypto/cryptoIntegrity';
import { reqToPromise, runTxOn } from '@/lib/crypto/indexedDbTx';
import {
  isSecureStoreNative,
  secureGetSecret,
  secureRemoveSecret,
  secureSetSecret,
} from '@/lib/secureStore';

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
  const encoded = bytesToBase64(new Uint8Array(ciphertext));
  const record: LocalPinRecord = {
    id: userId,
    version: PIN_VERSION,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    wrappedBlob: encoded,
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
      if (cancelled) return;
      const mode = localMode(user.id);
      const sessionUnlocked = storageGet(sessionStorage, SESSION_KEY) === user.id;
      const unlocked = Boolean(record) && (
        unlockCurrentOpen || (mode !== 'every_open' && sessionUnlocked)
      );
      pinModeRef.current = mode;
      setState({
        loaded: true,
        hasPin: Boolean(record),
        unlocked,
        error: null,
        processing: false,
        pinMode: mode,
      });
    };

    void refresh();
    const onPinStateChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: string; unlocked?: boolean }>).detail;
      if (!detail?.userId || detail.userId === user.id) void refresh(detail?.unlocked === true);
    };
    window.addEventListener(PIN_STATE_CHANGED_EVENT, onPinStateChanged);

    return () => {
      cancelled = true;
      window.removeEventListener(PIN_STATE_CHANGED_EVENT, onPinStateChanged);
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
      await saveLocalPin(user.id, pin);
      // This creates only an email-reset ticket. The PIN itself is deliberately
      // absent from the request and cannot be verified by the server.
      void supabase.functions.invoke('verify-chat-pin', {
        body: { action: 'register-local-recovery' },
      }).catch(() => undefined);
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
    const valid = await verifyLocalPin(user.id, pin);
    if (!valid) {
      setState((current) => ({ ...current, processing: false, error: 'PIN incorrect' }));
      return false;
    }
    announceUnlock(user.id);
    setState((current) => ({ ...current, unlocked: true, processing: false, error: null }));
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
};
