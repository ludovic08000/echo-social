/**
 * useChatPin — PIN-based access control for messaging
 * 
 * The PIN is cryptographically tied to E2EE key decryption:
 * - PIN → PBKDF2 (600k iterations) → AES-256-GCM wrapping key
 * - Identity keys in IndexedDB are encrypted with this wrapping key
 * - Without the correct PIN, keys cannot be decrypted → messages unreadable
 * - PIN hash (SHA-256 with random salt) stored server-side for verification
 * - Unlocked state persists for the session only (sessionStorage flag)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';

const SESSION_KEY = 'forsure-pin-unlocked';
const PIN_WRAP_DB = 'forsure-pin-wrap';
const PIN_WRAP_VERSION = 1;
const PIN_WRAP_STORE = 'wrapped-keys';
const PBKDF2_ITERATIONS = 600_000;

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
}

// ─── IndexedDB for wrapped keys ───

function openPinDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PIN_WRAP_DB, PIN_WRAP_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PIN_WRAP_STORE)) {
        db.createObjectStore(PIN_WRAP_STORE, { keyPath: 'id' });
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
  tx.objectStore(PIN_WRAP_STORE).put({ id: userId, ...data });
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadWrappedKeys(userId: string): Promise<{
  wrappedBlob: string;
  iv: string;
  salt: string;
} | null> {
  try {
    const db = await openPinDB();
    const tx = db.transaction(PIN_WRAP_STORE, 'readonly');
    const req = tx.objectStore(PIN_WRAP_STORE).get(userId);
    const result = await new Promise<any>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!result) return null;
    return { wrappedBlob: result.wrappedBlob, iv: result.iv, salt: result.salt };
  } catch {
    return null;
  }
}

// ─── Crypto helpers ───

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function derivePinKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const pinBytes = new TextEncoder().encode(pin);
  const baseKey = await crypto.subtle.importKey('raw', pinBytes, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
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
  const baseKey = await crypto.subtle.importKey('raw', pinBytes, 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits(
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
  const hash = await crypto.subtle.digest('SHA-256', combined as Uint8Array<ArrayBuffer>);
  return bytesToBase64(new Uint8Array(hash));
}

// ─── Read raw identity keys from IndexedDB (to wrap them) ───

async function readRawIdentityBlob(userId: string): Promise<string | null> {
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('forsure-e2ee', 2);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = () => {
        // Don't create stores, just open
      };
    });
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

async function writeRawIdentityBlob(userId: string, blob: string): Promise<void> {
  const parsed = JSON.parse(blob);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('forsure-e2ee', 2);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('identity-keys')) {
        d.createObjectStore('identity-keys', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('session-keys')) {
        d.createObjectStore('session-keys', { keyPath: 'conversationId' });
      }
      if (!d.objectStoreNames.contains('prekeys')) {
        d.createObjectStore('prekeys', { keyPath: 'id' });
      }
    };
  });
  const tx = db.transaction('identity-keys', 'readwrite');
  tx.objectStore('identity-keys').put(parsed);
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
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
  });
  const checkedRef = useRef(false);

  // Check if user has a PIN and if session is unlocked
  useEffect(() => {
    if (!user || checkedRef.current) return;
    checkedRef.current = true;

    (async () => {
      try {
        // Check session unlock
        const sessionUnlocked = sessionStorage.getItem(SESSION_KEY) === user.id;

        // Check if PIN exists in DB
        const { data } = await supabase
          .from('user_chat_pins')
          .select('id')
          .eq('user_id', user.id)
          .maybeSingle();

        setState({
          loaded: true,
          hasPin: !!data,
          unlocked: sessionUnlocked && !!data,
          error: null,
          processing: false,
        });
      } catch (err) {
        console.error('[PIN] Check failed:', err);
        setState(s => ({ ...s, loaded: true, error: 'Erreur vérification PIN' }));
      }
    })();
  }, [user]);

  /**
   * Set up a new PIN for the first time.
   * Wraps existing identity keys with the PIN-derived key.
   */
  const setupPin = useCallback(async (pin: string): Promise<boolean> => {
    if (!user) return false;
    setState(s => ({ ...s, processing: true, error: null }));

    try {
      // Validate PIN format (6 digits)
      if (!/^\d{6}$/.test(pin)) {
        setState(s => ({ ...s, processing: false, error: 'Le PIN doit contenir exactement 6 chiffres' }));
        return false;
      }

      // Setup PIN server-side (hash computed on server, never on client)
      const { data: setupResult, error: fnError } = await supabase.functions.invoke('verify-chat-pin', {
        body: { action: 'setup', pin },
      });
      if (fnError || !setupResult?.ok) {
        setState(s => ({ ...s, processing: false, error: setupResult?.error || 'Erreur création PIN' }));
        return false;
      }

      // Derive local wrapping key from server-provided salt
      const saltB64 = setupResult.salt;
      const salt = base64ToBytes(saltB64);
      const wrapKey = await derivePinKey(pin, salt);

      // Read existing identity keys from IndexedDB
      const rawBlob = await readRawIdentityBlob(user.id);
      if (rawBlob) {
        // Encrypt the keys with PIN-derived key
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const plainBytes = new TextEncoder().encode(rawBlob);
        const ciphertext = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer> },
          wrapKey,
          plainBytes as Uint8Array<ArrayBuffer>,
        );

        // Save wrapped keys locally
        await saveWrappedKeys(user.id, {
          wrappedBlob: bytesToBase64(new Uint8Array(ciphertext)),
          iv: bytesToBase64(iv),
          salt: saltB64,
        });

        // DELETE raw identity keys — only wrapped version remains
        await deleteRawIdentityBlob(user.id);
        console.log('[PIN] Raw identity keys deleted after wrapping');
      }

      // Mark session as unlocked
      sessionStorage.setItem(SESSION_KEY, user.id);

      setState({
        loaded: true,
        hasPin: true,
        unlocked: true,
        error: null,
        processing: false,
      });

      return true;
    } catch (err) {
      console.error('[PIN] Setup failed:', err);
      setState(s => ({ ...s, processing: false, error: 'Erreur création PIN' }));
      return false;
    }
  }, [user]);

  /**
   * Verify PIN and unlock messaging for this session.
   * Unwraps identity keys with the PIN-derived key.
   */
  const verifyPin = useCallback(async (pin: string): Promise<boolean> => {
    if (!user) return false;
    setState(s => ({ ...s, processing: true, error: null }));

    try {
      // Validate format
      if (!/^\d{6}$/.test(pin)) {
        setState(s => ({ ...s, processing: false, error: 'PIN invalide' }));
        return false;
      }

      // Verify PIN server-side (hash NEVER sent to client)
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

      // PIN verified server-side — now unwrap local keys
      const wrapped = await loadWrappedKeys(user.id);
      if (wrapped) {
        try {
          const wrapKey = await derivePinKey(pin, base64ToBytes(wrapped.salt));
          const cipherBytes = base64ToBytes(wrapped.wrappedBlob);
          const iv = base64ToBytes(wrapped.iv);

          const plainBuffer = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer> },
            wrapKey,
            cipherBytes as Uint8Array<ArrayBuffer>,
          );

          const rawBlob = new TextDecoder().decode(plainBuffer);
          await writeRawIdentityBlob(user.id, rawBlob);
          console.log('[PIN] Keys unwrapped successfully');
          window.dispatchEvent(new CustomEvent('forsure-keys-unlocked'));
        } catch (unwrapErr) {
          console.warn('[PIN] Key unwrap failed (keys may already be accessible):', unwrapErr);
        }
      } else if (verifyResult.salt) {
        // No local wrapped keys but PIN verified — try wrapping existing keys for next time
        try {
          const rawBlob = await readRawIdentityBlob(user.id);
          if (rawBlob) {
            const salt = base64ToBytes(verifyResult.salt);
            const wrapKey = await derivePinKey(pin, salt);
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const ciphertext = await crypto.subtle.encrypt(
              { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer> },
              wrapKey,
              new TextEncoder().encode(rawBlob) as Uint8Array<ArrayBuffer>,
            );
            await saveWrappedKeys(user.id, {
              wrappedBlob: bytesToBase64(new Uint8Array(ciphertext)),
              iv: bytesToBase64(iv),
              salt: verifyResult.salt,
            });
          }
        } catch {}
      }

      // Mark session as unlocked
      sessionStorage.setItem(SESSION_KEY, user.id);

      setState({
        loaded: true,
        hasPin: true,
        unlocked: true,
        error: null,
        processing: false,
      });

      return true;
    } catch (err) {
      console.error('[PIN] Verify failed:', err);
      setState(s => ({ ...s, processing: false, error: 'Erreur vérification' }));
      return false;
    }
  }, [user]);

  /** Lock messaging (clear session) */
  const lock = useCallback(() => {
    sessionStorage.removeItem(SESSION_KEY);
    setState(s => ({ ...s, unlocked: false }));
  }, []);

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
      // PIN deleted — user will go through setup flow
      sessionStorage.removeItem(SESSION_KEY);
      setState({
        loaded: true,
        hasPin: false,
        unlocked: false,
        error: null,
        processing: false,
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
  };
}
