/**
 * useE2EE - React hook for End-to-End Encryption
 * 
 * Uses Double Ratchet for 1:1 conversations (forward secrecy per message).
 * Falls back to single-key AES-GCM for Zeus and group chats.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import {
  getOrCreateIdentityKeys,
  exportPublicKeyBundle,
  // Legacy (Zeus / groups / fallback)
  encryptMessage,
  decryptMessage,
  isEncryptedMessage,
  establishSession,
  loadSessionKey,
  incrementSessionMessageCount,
  needsKeyRotation,
  rotateSessionKey,
  // Double Ratchet
  initRatchetAsInitiator,
  initRatchetAsResponder,
  ratchetEncrypt,
  ratchetDecrypt,
  serializeRatchetState,
  deserializeRatchetState,
  type IdentityKeyPair,
  type RatchetState,
  type RatchetEnvelope,
} from '@/lib/crypto';
import { base64ToBuffer, bufferToBase64 } from '@/lib/crypto/utils';
import { cryptoRateCheck, isCryptoLocked, onCryptoViolation } from '@/lib/crypto/rateLimiter';
import { KX_KEY_PARAMS } from '@/lib/crypto/constants';

const ZEUS_ID = '00000000-0000-0000-0000-000000000001';
const RATCHET_DB_NAME = 'forsure-ratchet';
const RATCHET_DB_VERSION = 1;
const RATCHET_STORE_NAME = 'ratchet-states';

// ─── IndexedDB ratchet persistence (XSS-resistant) ───

function openRatchetDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(RATCHET_DB_NAME, RATCHET_DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RATCHET_STORE_NAME)) {
        db.createObjectStore(RATCHET_STORE_NAME, { keyPath: 'convId' });
      }
    };
  });
}

async function saveRatchetLocal(convId: string, state: RatchetState) {
  try {
    const json = await serializeRatchetState(state);
    const db = await openRatchetDB();
    const tx = db.transaction(RATCHET_STORE_NAME, 'readwrite');
    tx.objectStore(RATCHET_STORE_NAME).put({ convId, data: json });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('[E2EE] Failed to persist ratchet state:', e);
  }
}

async function loadRatchetLocal(convId: string): Promise<RatchetState | null> {
  try {
    const db = await openRatchetDB();
    const tx = db.transaction(RATCHET_STORE_NAME, 'readonly');
    const req = tx.objectStore(RATCHET_STORE_NAME).get(convId);
    const result = await new Promise<any>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!result?.data) return null;
    return deserializeRatchetState(result.data);
  } catch {
    return null;
  }
}

// Clean up any legacy localStorage ratchet data
function cleanupLegacyStorage() {
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('forsure-ratchet-states:')) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
  } catch {}
}


// ─── Hook ───

export interface E2EEState {
  ready: boolean;
  fingerprint: string | null;
  peerFingerprint: string | null;
  encrypted: boolean;
  ratchetActive: boolean;
}

export function useE2EE(conversationId: string | undefined, peerUserId: string | undefined) {
  const { user } = useAuth();
  const [state, setState] = useState<E2EEState>({
    ready: false,
    fingerprint: null,
    peerFingerprint: null,
    encrypted: false,
    ratchetActive: false,
  });
  const keysRef = useRef<IdentityKeyPair | null>(null);
  const peerKeyRef = useRef<{ identityKey: string; signingKey: string; fingerprint: string } | null>(null);
  const ratchetRef = useRef<RatchetState | null>(null);
  const initRef = useRef(false);

  const isZeus = peerUserId === ZEUS_ID;

  // Initialize identity keys + publish
  useEffect(() => {
    if (!user || initRef.current) return;
    initRef.current = true;
    cleanupLegacyStorage();

    (async () => {
      try {
        const keys = await getOrCreateIdentityKeys(user.id);
        keysRef.current = keys;

        const bundle = await exportPublicKeyBundle(keys);

        await supabase
          .from('user_public_keys' as any)
          .upsert({
            user_id: user.id,
            identity_key: bundle.identityKey,
            signing_key: bundle.signingKey,
            fingerprint: bundle.fingerprint,
            kem_type: 'X25519',
            is_active: true,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'user_id,is_active' });

        setState(s => ({ ...s, fingerprint: bundle.fingerprint }));
      } catch (err) {
        console.error('[E2EE] Init failed:', err);
      }
    })();
  }, [user]);

  // Fetch peer public key
  useEffect(() => {
    if (!peerUserId || !user) return;

    // Zeus doesn't have E2EE keys — use legacy symmetric encryption
    if (isZeus) {
      setState(s => ({ ...s, encrypted: false, ready: true, ratchetActive: false }));
      return;
    }

    (async () => {
      try {
        const { data } = await supabase
          .from('user_public_keys' as any)
          .select('identity_key, signing_key, fingerprint')
          .eq('user_id', peerUserId)
          .eq('is_active', true)
          .maybeSingle();

        if (data) {
          peerKeyRef.current = {
            identityKey: (data as any).identity_key,
            signingKey: (data as any).signing_key,
            fingerprint: (data as any).fingerprint,
          };

          // Try to load existing ratchet state
          if (conversationId) {
            const existing = await loadRatchetLocal(conversationId);
            if (existing) {
              ratchetRef.current = existing;
            }
          }

          setState(s => ({
            ...s,
            peerFingerprint: (data as any).fingerprint,
            encrypted: true,
            ready: !!keysRef.current,
            ratchetActive: !!ratchetRef.current,
          }));
        } else {
          setState(s => ({ ...s, encrypted: false, ready: true }));
        }
      } catch {
        setState(s => ({ ...s, encrypted: false, ready: true }));
      }
    })();
  }, [peerUserId, user, conversationId, isZeus]);

  // Initialize ratchet session if needed
  const ensureRatchet = useCallback(async (): Promise<RatchetState | null> => {
    if (!conversationId || !keysRef.current || !peerKeyRef.current) return null;

    if (ratchetRef.current) return ratchetRef.current;

    // Rate-limit key derivation (expensive + sensitive)
    if (!cryptoRateCheck('deriveBits')) {
      console.warn('[E2EE] Key derivation rate-limited');
      return null;
    }

    try {
      // X25519 DH to get initial shared secret
      const peerPubRaw = base64ToBuffer(peerKeyRef.current.identityKey);
      const peerPubKey = await crypto.subtle.importKey(
        'raw', peerPubRaw, KX_KEY_PARAMS as any, true, []
      );

      const sharedBits = await crypto.subtle.deriveBits(
        { name: 'X25519', public: peerPubKey } as any,
        keysRef.current.privateKey,
        256,
      );

      // Deterministic role: lower fingerprint is initiator
      const myFp = keysRef.current.fingerprint;
      const peerFp = peerKeyRef.current.fingerprint;
      const isInitiator = myFp < peerFp;

      let ratchetState: RatchetState;
      if (isInitiator) {
        ratchetState = await initRatchetAsInitiator(conversationId, sharedBits, peerPubKey);
      } else {
        const dhPair = await crypto.subtle.generateKey(
          KX_KEY_PARAMS as any, true, ['deriveBits']
        ) as CryptoKeyPair;
        ratchetState = await initRatchetAsResponder(conversationId, sharedBits, dhPair);
      }

      ratchetRef.current = ratchetState;
      await saveRatchetLocal(conversationId, ratchetState);
      setState(s => ({ ...s, ratchetActive: true }));
      return ratchetState;
    } catch (err) {
      console.error('[E2EE] Ratchet init failed, falling back to legacy:', err);
      return null;
    }
  }, [conversationId]);

  // Legacy session fallback
  const ensureLegacySession = useCallback(async () => {
    if (!conversationId || !keysRef.current || !peerKeyRef.current) return null;
    let session = await loadSessionKey(conversationId);
    if (!session || await needsKeyRotation(conversationId)) {
      session = await (session
        ? rotateSessionKey(keysRef.current, peerKeyRef.current.identityKey, conversationId, peerKeyRef.current.fingerprint)
        : establishSession(keysRef.current, peerKeyRef.current.identityKey, conversationId, peerKeyRef.current.fingerprint)
      );
    }
    return session;
  }, [conversationId]);

  // Encrypt — with rate-limiting to detect bulk exfiltration
  const encrypt = useCallback(async (plaintext: string): Promise<string> => {
    if (!state.encrypted || !keysRef.current) return plaintext;

    if (!cryptoRateCheck('encrypt')) {
      console.warn('[E2EE] Encrypt rate-limited — possible exfiltration attempt');
      return plaintext;
    }

    try {
      // Try Double Ratchet first
      const ratchet = await ensureRatchet();
      if (ratchet) {
        if (!cryptoRateCheck('sign')) return plaintext;
        const { envelope, newState } = await ratchetEncrypt(
          ratchet,
          plaintext,
          keysRef.current.signingPrivateKey,
          keysRef.current.fingerprint,
        );
        ratchetRef.current = newState;
        await saveRatchetLocal(conversationId!, newState);
        return JSON.stringify(envelope);
      }

      // Fallback to legacy
      const session = await ensureLegacySession();
      if (!session) return plaintext;
      if (!cryptoRateCheck('sign')) return plaintext;
      const seq = await incrementSessionMessageCount(conversationId!);
      return await encryptMessage(
        plaintext, session.sharedSecret,
        keysRef.current.signingPrivateKey, keysRef.current.fingerprint, seq,
      );
    } catch (err) {
      console.error('[E2EE] Encrypt failed:', err);
      return plaintext;
    }
  }, [state.encrypted, conversationId, ensureRatchet, ensureLegacySession]);

  // Decrypt — with rate-limiting to detect bulk exfiltration
  const decrypt = useCallback(async (body: string): Promise<{ text: string; encrypted: boolean; verified: boolean }> => {
    if (!isEncryptedMessage(body) && !isRatchetEnvelope(body)) {
      return { text: body, encrypted: false, verified: false };
    }

    if (!cryptoRateCheck('decrypt')) {
      return { text: '🔒 Opération limitée (sécurité)', encrypted: true, verified: false };
    }

    try {
      // Check if it's a ratchet envelope
      if (isRatchetEnvelope(body)) {
        const envelope: RatchetEnvelope = JSON.parse(body);
        let ratchet = ratchetRef.current || await ensureRatchet();
        if (!ratchet) {
          return { text: '🔒 Clé de session manquante', encrypted: true, verified: false };
        }

        const { plaintext, verified, newState } = await ratchetDecrypt(
          ratchet, envelope, peerKeyRef.current?.signingKey,
        );
        ratchetRef.current = newState;
        await saveRatchetLocal(conversationId!, newState);
        return { text: plaintext, encrypted: true, verified };
      }

      // Legacy envelope
      const session = await ensureLegacySession();
      if (!session) return { text: '🔒 Message chiffré (clé manquante)', encrypted: true, verified: false };
      const result = await decryptMessage(body, session.sharedSecret, peerKeyRef.current?.signingKey);
      return { text: result.plaintext, encrypted: true, verified: result.verified };
    } catch (err) {
      console.error('[E2EE] Decrypt failed:', err);
      return { text: '🔒 Impossible de déchiffrer', encrypted: true, verified: false };
    }
  }, [conversationId, ensureRatchet, ensureLegacySession]);

  return {
    ...state,
    encrypt,
    decrypt,
  };
}

// ─── Helpers ───

function isRatchetEnvelope(body: string): boolean {
  if (!body.startsWith('{')) return false;
  try {
    const p = JSON.parse(body);
    return p.v !== undefined && p.hdr !== undefined && p.ct !== undefined;
  } catch {
    return false;
  }
}
