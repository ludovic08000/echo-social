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
  version: 2;
  salt: string;
  iv: string;
  wrappedBlob: string;
  ciphertext: string;
  createdAt: number;
}

const STORE = 'pin-wrapped-keys';
const SESSION_KEY = 'forsure-pin-unlocked';
const MODE_PREFIX = 'forsure-pin-mode:';
const PIN_VERSION = 2;
const PBKDF2_ITERATIONS = 600_000;
const INACTIVITY_TIMEOUT = 5 * 60_000;
const VERIFIER_PREFIX = 'FORSURE-LOCAL-PIN-v2|';

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

function localMode(userId: string): PinMode {
  const value = localStorage.getItem(`${MODE_PREFIX}${userId}`);
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
  if (
    !value ||
    value.version !== PIN_VERSION ||
    typeof value.salt !== 'string' ||
    typeof value.iv !== 'string' ||
    typeof value.wrappedBlob !== 'string'
  ) {
    return null;
  }
  return value as LocalPinRecord;
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
    ciphertext: encoded,
    createdAt: Date.now(),
  };
  await runTxOn('pin-wrap', [STORE], 'readwrite', (tx) => {
    tx.objectStore(STORE).put(record);
  });
}

async function removeLocalPin(userId: string): Promise<void> {
  await runTxOn('pin-wrap', [STORE], 'readwrite', (tx) => {
    tx.objectStore(STORE).delete(userId);
  });
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
  sessionStorage.setItem(SESSION_KEY, userId);
  window.dispatchEvent(new CustomEvent('forsure-keys-unlocked'));
  window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
    detail: { reason: 'local_pin_unlocked' },
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

    void (async () => {
      const record = await loadLocalPin(user.id);
      if (cancelled) return;
      const mode = localMode(user.id);
      const sessionUnlocked = sessionStorage.getItem(SESSION_KEY) === user.id;
      const unlocked = Boolean(record) && mode !== 'every_open' && sessionUnlocked;
      pinModeRef.current = mode;
      setState({
        loaded: true,
        hasPin: Boolean(record),
        unlocked,
        error: null,
        processing: false,
        pinMode: mode,
      });
    })();

    return () => { cancelled = true; };
  }, [user?.id]);

  const lock = useCallback(async () => {
    sessionStorage.removeItem(SESSION_KEY);
    setState((current) => ({ ...current, unlocked: false }));
    window.dispatchEvent(new CustomEvent('forsure-messaging-locked'));
  }, []);

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
      localStorage.setItem(`${MODE_PREFIX}${user.id}`, 'every_open');
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
    localStorage.setItem(`${MODE_PREFIX}${user.id}`, mode);
    pinModeRef.current = mode;
    setState((current) => ({ ...current, pinMode: mode }));
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
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(`${MODE_PREFIX}${user.id}`);
    pinModeRef.current = 'every_open';
    setState({
      loaded: true,
      hasPin: false,
      unlocked: false,
      error: null,
      processing: false,
      pinMode: 'every_open',
    });
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
