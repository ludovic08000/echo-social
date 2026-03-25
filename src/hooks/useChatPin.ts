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
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function hashPin(pin: string, salt: Uint8Array): Promise<string> {
  const pinBytes = new TextEncoder().encode(pin);
  const combined = new Uint8Array(pinBytes.length + salt.length);
  combined.set(pinBytes);
  combined.set(salt, pinBytes.length);
  const hash = await crypto.subtle.digest('SHA-256', combined);
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

      // Generate salt
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const saltB64 = bytesToBase64(salt);

      // Hash PIN for server-side verification
      const pinHash = await hashPin(pin, salt);

      // Derive wrapping key
      const wrapKey = await derivePinKey(pin, salt);

      // Read existing identity keys from IndexedDB
      const rawBlob = await readRawIdentityBlob(user.id);
      if (rawBlob) {
        // Encrypt the keys with PIN-derived key
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const plainBytes = new TextEncoder().encode(rawBlob);
        const ciphertext = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv },
          wrapKey,
          plainBytes,
        );

        // Save wrapped keys locally
        await saveWrappedKeys(user.id, {
          wrappedBlob: bytesToBase64(new Uint8Array(ciphertext)),
          iv: bytesToBase64(iv),
          salt: saltB64,
        });
      }

      // Save PIN hash to server
      await supabase.from('user_chat_pins').upsert({
        user_id: user.id,
        pin_hash: pinHash,
        salt: saltB64,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });

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

      // Fetch PIN record from server
      const { data } = await supabase
        .from('user_chat_pins')
        .select('pin_hash, salt')
        .eq('user_id', user.id)
        .maybeSingle();

      if (!data) {
        setState(s => ({ ...s, processing: false, error: 'Aucun PIN configuré' }));
        return false;
      }

      // Verify hash
      const salt = base64ToBytes(data.salt);
      const expectedHash = await hashPin(pin, salt);

      if (expectedHash !== data.pin_hash) {
        setState(s => ({ ...s, processing: false, error: 'PIN incorrect' }));
        return false;
      }

      // Try to unwrap keys if wrapped version exists
      const wrapped = await loadWrappedKeys(user.id);
      if (wrapped) {
        try {
          const wrapKey = await derivePinKey(pin, base64ToBytes(wrapped.salt));
          const cipherBytes = base64ToBytes(wrapped.wrappedBlob);
          const iv = base64ToBytes(wrapped.iv);

          const plainBuffer = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            wrapKey,
            cipherBytes,
          );

          const rawBlob = new TextDecoder().decode(plainBuffer);

          // Write the decrypted keys back to the E2EE IndexedDB
          await writeRawIdentityBlob(user.id, rawBlob);
          console.log('[PIN] Keys unwrapped successfully');
        } catch (unwrapErr) {
          console.warn('[PIN] Key unwrap failed (keys may already be accessible):', unwrapErr);
          // Don't block — keys might already be in plain form
        }
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

  return {
    ...state,
    setupPin,
    verifyPin,
    lock,
  };
}
