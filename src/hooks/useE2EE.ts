/**
 * useE2EE - React hook for End-to-End Encryption (HARDENED)
 * 
 * SECURITY GUARANTEES:
 * - encrypt() NEVER returns plaintext — throws on failure
 * - decrypt() NEVER shows raw ciphertext — shows explicit error states
 * - Fingerprint changes are detected and flagged
 * - verified=true ONLY when signature is cryptographically verified
 * 
 * Uses Double Ratchet for 1:1 conversations (forward secrecy per message).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import {
  getOrCreateIdentityKeys,
  exportPublicKeyBundle,
  encryptMessage,
  decryptMessage,
  isEncryptedMessage,
  establishSession,
  loadSessionKey,
  incrementSessionMessageCount,
  needsKeyRotation,
  rotateSessionKey,
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
import { cryptoRateCheck } from '@/lib/crypto/rateLimiter';
import { KX_KEY_PARAMS } from '@/lib/crypto/constants';

const ZEUS_ID = '00000000-0000-0000-0000-000000000001';
const RATCHET_DB_NAME = 'forsure-ratchet';
const RATCHET_DB_VERSION = 1;
const RATCHET_STORE_NAME = 'ratchet-states';
const KNOWN_FP_KEY = 'forsure-known-fps';

// ─── IndexedDB ratchet persistence ───

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

// ─── Fingerprint verification ───

function getKnownFingerprints(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KNOWN_FP_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveKnownFingerprint(userId: string, fp: string) {
  const known = getKnownFingerprints();
  known[userId] = fp;
  localStorage.setItem(KNOWN_FP_KEY, JSON.stringify(known));
}

function checkFingerprintChange(userId: string, currentFp: string): boolean {
  const known = getKnownFingerprints();
  const previousFp = known[userId];
  if (previousFp && previousFp !== currentFp) {
    console.warn('[PEER_KEY] fingerprint changed for', userId);
    return true;
  }
  return false;
}

// Clean up legacy localStorage ratchet data
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
  /** True if peer fingerprint changed since last known value */
  fingerprintChanged: boolean;
  /** True if peer has no public keys (encryption impossible) */
  peerKeyMissing: boolean;
  /** Initialization error if any */
  initError: string | null;
}

export function useE2EE(conversationId: string | undefined, peerUserId: string | undefined) {
  const { user } = useAuth();
  const [state, setState] = useState<E2EEState>({
    ready: false,
    fingerprint: null,
    peerFingerprint: null,
    encrypted: false,
    ratchetActive: false,
    fingerprintChanged: false,
    peerKeyMissing: false,
    initError: null,
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
          .from('user_public_keys')
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
        setState(s => ({ ...s, initError: 'Key initialization failed' }));
      }
    })();
  }, [user]);

  // Fetch peer public key
  useEffect(() => {
    if (!peerUserId || !user) return;

    if (isZeus) {
      setState(s => ({ ...s, encrypted: false, ready: true, ratchetActive: false }));
      return;
    }

    (async () => {
      try {
        const { data } = await supabase
          .from('user_public_keys')
          .select('identity_key, signing_key, fingerprint')
          .eq('user_id', peerUserId)
          .eq('is_active', true)
          .maybeSingle();

        if (data) {
          console.log('[PEER_KEY] loaded', peerUserId);

          // Check for fingerprint change
          const fpChanged = checkFingerprintChange(peerUserId, data.fingerprint);
          saveKnownFingerprint(peerUserId, data.fingerprint);

          peerKeyRef.current = {
            identityKey: data.identity_key,
            signingKey: data.signing_key,
            fingerprint: data.fingerprint,
          };

          // Try to load existing ratchet state
          if (conversationId) {
            const existing = await loadRatchetLocal(conversationId);
            if (existing) {
              ratchetRef.current = existing;
              console.log('[RATCHET] ready state — loaded from IndexedDB');
            }
          }

          setState(s => ({
            ...s,
            peerFingerprint: data.fingerprint,
            encrypted: true,
            ready: !!keysRef.current,
            ratchetActive: !!ratchetRef.current,
            fingerprintChanged: fpChanged,
            peerKeyMissing: false,
          }));
        } else {
          console.log('[PEER_KEY] not found for', peerUserId);
          setState(s => ({
            ...s,
            encrypted: false,
            ready: true,
            peerKeyMissing: true,
          }));
        }
      } catch (err) {
        console.error('[E2EE] Peer key fetch failed:', err);
        setState(s => ({
          ...s,
          encrypted: false,
          ready: true,
          initError: 'Peer key fetch failed',
        }));
      }
    })();
  }, [peerUserId, user, conversationId, isZeus]);

  // Initialize ratchet session if needed
  const ensureRatchet = useCallback(async (): Promise<RatchetState | null> => {
    if (!conversationId || !keysRef.current || !peerKeyRef.current) return null;

    if (ratchetRef.current) return ratchetRef.current;

    if (!cryptoRateCheck('deriveBits')) {
      console.warn('[E2EE] Key derivation rate-limited');
      return null;
    }

    try {
      const peerPubRaw = base64ToBuffer(peerKeyRef.current.identityKey);
      const peerPubKey = await crypto.subtle.importKey(
        'raw', peerPubRaw, KX_KEY_PARAMS as any, true, []
      );

      const sharedBits = await crypto.subtle.deriveBits(
        { name: 'X25519', public: peerPubKey } as any,
        keysRef.current.privateKey,
        256,
      );

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
      console.log('[RATCHET] ready state — initialized');
      setState(s => ({ ...s, ratchetActive: true }));
      return ratchetState;
    } catch (err) {
      console.error('[E2EE] Ratchet init failed:', err);
      return null;
    }
  }, [conversationId]);

  // Legacy session (for when ratchet cannot be used)
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

  /**
   * Encrypt — NEVER returns plaintext.
   * Throws EncryptionError if encryption fails.
   */
  const encrypt = useCallback(async (plaintext: string): Promise<string> => {
    // If encryption is not active (Zeus, no peer keys), this is a programming error
    if (!state.encrypted || !keysRef.current) {
      throw new EncryptionError('Encryption not available — keys not ready');
    }

    if (!cryptoRateCheck('encrypt')) {
      throw new EncryptionError('Rate limited — possible exfiltration attempt');
    }

    // Try Double Ratchet first
    const ratchet = await ensureRatchet();
    if (ratchet) {
      if (!cryptoRateCheck('sign')) {
        throw new EncryptionError('Signing rate limited');
      }
      const { envelope, newState } = await ratchetEncrypt(
        ratchet,
        plaintext,
        keysRef.current.signingPrivateKey,
        keysRef.current.fingerprint,
      );
      ratchetRef.current = newState;
      await saveRatchetLocal(conversationId!, newState);
      const result = JSON.stringify(envelope);
      console.log('[E2EE] encrypt success (ratchet)');
      return result;
    }

    // Fallback to legacy session-based encryption
    const session = await ensureLegacySession();
    if (!session) {
      throw new EncryptionError('No encryption session available');
    }

    if (!cryptoRateCheck('sign')) {
      throw new EncryptionError('Signing rate limited');
    }

    const seq = await incrementSessionMessageCount(conversationId!);
    const result = await encryptMessage(
      plaintext, session.sharedSecret,
      keysRef.current.signingPrivateKey, keysRef.current.fingerprint, seq,
    );
    console.log('[E2EE] encrypt success (legacy)');
    return result;
  }, [state.encrypted, conversationId, ensureRatchet, ensureLegacySession]);

  /**
   * Decrypt — NEVER shows raw ciphertext.
   * Returns explicit error messages on failure.
   */
  const decrypt = useCallback(async (body: string): Promise<{ text: string; encrypted: boolean; verified: boolean }> => {
    if (!isEncryptedMessage(body) && !isRatchetEnvelope(body)) {
      return { text: body, encrypted: false, verified: false };
    }

    if (!cryptoRateCheck('decrypt')) {
      return { text: '🔒 Opération limitée (sécurité)', encrypted: true, verified: false };
    }

    try {
      if (isRatchetEnvelope(body)) {
        console.log('[E2EE] decrypt start (ratchet)');
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
        console.log('[E2EE] decrypt success', verified ? '(verified)' : '(unverified)');
        return { text: plaintext, encrypted: true, verified };
      }

      // Legacy envelope
      console.log('[E2EE] decrypt start (legacy)');
      const session = await ensureLegacySession();
      if (!session) {
        return { text: '🔒 Clé de session manquante', encrypted: true, verified: false };
      }
      const result = await decryptMessage(body, session.sharedSecret, peerKeyRef.current?.signingKey);
      console.log('[E2EE] decrypt success', result.verified ? '(verified)' : '(unverified)');
      return { text: result.plaintext, encrypted: true, verified: result.verified };
    } catch (err) {
      console.error('[E2EE] decrypt failed:', err);
      return { text: '🔒 Message illisible', encrypted: true, verified: false };
    }
  }, [conversationId, ensureRatchet, ensureLegacySession]);

  /** Check if encryption is ready for this conversation */
  const isReady = useCallback((): boolean => {
    return state.encrypted && state.ready && !!keysRef.current && !!peerKeyRef.current;
  }, [state.encrypted, state.ready]);

  /** Acknowledge fingerprint change */
  const acknowledgeFingerprint = useCallback(() => {
    setState(s => ({ ...s, fingerprintChanged: false }));
  }, []);

  return {
    ...state,
    encrypt,
    decrypt,
    isReady,
    acknowledgeFingerprint,
  };
}

// ─── Custom error ───

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionError';
  }
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
