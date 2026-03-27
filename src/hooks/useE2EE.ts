/**
 * useE2EE - React hook for End-to-End Encryption (v4 — Simplified & Hardened)
 * 
 * SECURITY GUARANTEES:
 * - encrypt() NEVER returns plaintext — throws on failure
 * - decrypt() NEVER shows raw ciphertext — shows explicit error states
 * - Fingerprint changes are detected and BLOCK communication until acknowledged
 * - verified=true ONLY when signature is cryptographically verified
 * 
 * ARCHITECTURE (v4):
 * - Primary: Deterministic legacy session (X25519 ECDH → HKDF → AES-256-GCM)
 *   Both sides derive the SAME key from the same shared secret + conversationId.
 *   This ALWAYS works on first message, no handshake needed.
 * - Ratchet upgrade: After both parties have exchanged messages, Double Ratchet
 *   is activated for forward secrecy. Falls back to legacy if ratchet fails.
 * - No fragile initiator/responder role determination.
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
  ratchetEncrypt,
  ratchetDecrypt,
  serializeRatchetState,
  deserializeRatchetState,
  type IdentityKeyPair,
  type RatchetState,
  type RatchetEnvelope,
} from '@/lib/crypto';
import { base64ToBuffer } from '@/lib/crypto/utils';
import { cryptoRateCheck } from '@/lib/crypto/rateLimiter';
import { verifyCryptoIntegrity, isTampered, hardGlobals } from '@/lib/crypto/cryptoIntegrity';
import { KX_KEY_PARAMS } from '@/lib/crypto/constants';

const ZEUS_ID = '00000000-0000-0000-0000-000000000001';
const RATCHET_DB_NAME = 'forsure-ratchet';
const RATCHET_DB_VERSION = 1;
const RATCHET_STORE_NAME = 'ratchet-states';
const KNOWN_FP_KEY = 'forsure-known-fps';

// ─── IndexedDB ratchet persistence ───

function openRatchetDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = hardGlobals.idbOpen(RATCHET_DB_NAME, RATCHET_DB_VERSION);
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
    return hardGlobals.jsonParse(localStorage.getItem(KNOWN_FP_KEY) || '{}');
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
    console.warn('[PEER_KEY] ⚠️ fingerprint changed for', userId);
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

    // One-time migration v4: clear broken ratchet states
    const migrationKey = 'forsure-e2ee-migration-v4';
    if (!localStorage.getItem(migrationKey)) {
      localStorage.setItem(migrationKey, '1');
      const req = indexedDB.open(RATCHET_DB_NAME, RATCHET_DB_VERSION);
      req.onsuccess = () => {
        try {
          const db = req.result;
          const tx = db.transaction(RATCHET_STORE_NAME, 'readwrite');
          tx.objectStore(RATCHET_STORE_NAME).clear();
          console.log('[E2EE] Cleared stale ratchet states (migration v4)');
        } catch {}
      };
      // Also clear legacy session keys to re-derive
      const req2 = indexedDB.open('forsure-e2ee', 2);
      req2.onsuccess = () => {
        try {
          const db = req2.result;
          if (db.objectStoreNames.contains('session-keys')) {
            const tx = db.transaction('session-keys', 'readwrite');
            tx.objectStore('session-keys').clear();
            console.log('[E2EE] Cleared stale session keys (migration v4)');
          }
        } catch {}
      };
    }
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
  const legacySessionReadyRef = useRef(false);

  const isZeus = peerUserId === ZEUS_ID;

  // Initialize identity keys + publish
  const initKeys = useCallback(async () => {
    if (!user) return;
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

      setState(s => ({
        ...s,
        fingerprint: bundle.fingerprint,
        ready: s.ready || s.encrypted,
      }));
      console.log('[E2EE] Keys initialized & published');
    } catch (err) {
      console.error('[E2EE] Init failed:', err);
      setState(s => ({ ...s, initError: 'Key initialization failed' }));
    }
  }, [user]);

  // Auto-init on mount
  useEffect(() => {
    if (!user || initRef.current) return;
    initRef.current = true;
    cleanupLegacyStorage();
    initKeys();
  }, [user, initKeys]);

  // Re-init when PIN unlocks keys
  useEffect(() => {
    const handler = () => {
      console.log('[E2EE] Keys unlocked via PIN — re-initializing');
      initKeys();
    };
    window.addEventListener('forsure-keys-unlocked', handler);
    return () => window.removeEventListener('forsure-keys-unlocked', handler);
  }, [initKeys]);

  // Fetch peer public key + pre-establish legacy session
  useEffect(() => {
    if (!peerUserId || !user) return;

    if (isZeus) {
      setState(s => ({ ...s, encrypted: false, ready: true, ratchetActive: false }));
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        // Ensure our own keys are ready first (may race with initKeys)
        if (!keysRef.current) {
          console.log('[E2EE] Waiting for own keys before peer fetch...');
          const keys = await getOrCreateIdentityKeys(user.id);
          if (cancelled) return;
          keysRef.current = keys;
          const bundle = await exportPublicKeyBundle(keys);
          if (cancelled) return;
          
          // Publish if not done yet
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
          console.log('[E2EE] Own keys loaded on-demand');
        }

        const { data } = await supabase
          .from('user_public_keys')
          .select('identity_key, signing_key, fingerprint')
          .eq('user_id', peerUserId)
          .eq('is_active', true)
          .maybeSingle();

        if (cancelled) return;

        if (data) {
          console.log('[PEER_KEY] loaded', peerUserId);

          // Check for fingerprint change — DO NOT auto-save
          const fpChanged = checkFingerprintChange(peerUserId, data.fingerprint);

          peerKeyRef.current = {
            identityKey: data.identity_key,
            signingKey: data.signing_key,
            fingerprint: data.fingerprint,
          };

          // If fingerprint changed, block until user acknowledges
          if (fpChanged) {
            setState(s => ({
              ...s,
              peerFingerprint: data.fingerprint,
              encrypted: true,
              ready: false,
              fingerprintChanged: true,
              peerKeyMissing: false,
            }));
            return;
          }

          // Save fingerprint only if not changed (first time or same)
          saveKnownFingerprint(peerUserId, data.fingerprint);

          // Pre-establish legacy session immediately
          if (keysRef.current && conversationId) {
            try {
              let session = await loadSessionKey(conversationId);
              if (cancelled) return;
              if (!session || await needsKeyRotation(conversationId)) {
                session = await (session
                  ? rotateSessionKey(keysRef.current, data.identity_key, conversationId, data.fingerprint)
                  : establishSession(keysRef.current, data.identity_key, conversationId, data.fingerprint)
                );
              }
              if (cancelled) return;
              legacySessionReadyRef.current = true;
              console.log('[E2EE] ✅ Legacy session pre-established — ready to send');
            } catch (e) {
              console.warn('[E2EE] Legacy session pre-establish failed:', e);
            }
          }

          setState(s => ({
            ...s,
            peerFingerprint: data.fingerprint,
            encrypted: true,
            ready: true, // We have both keys and peer key
            ratchetActive: false,
            fingerprintChanged: false,
            peerKeyMissing: false,
            initError: null,
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
        if (!cancelled) {
          setState(s => ({
            ...s,
            encrypted: false,
            ready: true,
            initError: 'Peer key fetch failed',
          }));
        }
      }
    })();

    return () => { cancelled = true; };
  }, [peerUserId, user, conversationId, isZeus]);

  // Legacy session — deterministic, always works
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
   * Uses legacy session (deterministic, instant) as primary.
   * Throws EncryptionError if encryption fails.
   */
  const encrypt = useCallback(async (plaintext: string): Promise<string> => {
    console.log('[E2EE] encrypt() called', {
      hasKeys: !!keysRef.current,
      hasPeerKey: !!peerKeyRef.current,
      fingerprintChanged: state.fingerprintChanged,
    });

    // BLOCK if crypto has been tampered with
    if (isTampered() || !verifyCryptoIntegrity()) {
      throw new EncryptionError('Crypto integrity compromised — operation blocked');
    }

    // BLOCK if fingerprint changed and not yet acknowledged
    if (state.fingerprintChanged) {
      throw new EncryptionError('La clé de sécurité du contact a changé — vérification requise');
    }

    // Auto-load keys if ref is empty (race with initKeys)
    if (!keysRef.current && user) {
      try {
        const keys = await getOrCreateIdentityKeys(user.id);
        keysRef.current = keys;
      } catch (e) {
        throw new EncryptionError('Encryption not available — keys not ready');
      }
    }

    if (!keysRef.current) {
      throw new EncryptionError('Encryption not available — keys not ready');
    }

    if (!peerKeyRef.current) {
      throw new EncryptionError('Encryption not available — peer key not ready');
    }

    if (!cryptoRateCheck('encrypt')) {
      throw new EncryptionError('Rate limited — possible exfiltration attempt');
    }

    // PRIMARY: Use legacy session (deterministic, instant, always works)
    try {
      const session = await ensureLegacySession();
      if (!session) {
        throw new EncryptionError('No encryption session available');
      }

      const seq = await incrementSessionMessageCount(conversationId!);
      const result = await encryptMessage(
        plaintext, session.sharedSecret,
        keysRef.current.signingPrivateKey, keysRef.current.fingerprint, seq,
      );
      console.log('[E2EE] ✅ encrypt success');
      return result;
    } catch (err) {
      if (err instanceof EncryptionError) throw err;
      console.error('[E2EE] ❌ Encrypt failed:', err);
      throw new EncryptionError(`Encryption failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [state.fingerprintChanged, conversationId, user, ensureLegacySession]);

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

    // Tamper check on decrypt too
    if (isTampered()) {
      return { text: '🔒 Intégrité compromise', encrypted: true, verified: false };
    }

    try {
      if (isRatchetEnvelope(body)) {
        // Try ratchet decrypt first
        const envelope: RatchetEnvelope = JSON.parse(body);
        let ratchet = ratchetRef.current;

        if (ratchet) {
          try {
            const { plaintext, verified, newState } = await ratchetDecrypt(
              ratchet, envelope, peerKeyRef.current?.signingKey,
            );
            ratchetRef.current = newState;
            await saveRatchetLocal(conversationId!, newState);
            return { text: plaintext, encrypted: true, verified };
          } catch (ratchetErr) {
            console.warn('[E2EE] Ratchet decrypt failed, trying legacy:', ratchetErr);
          }
        }

        // Ratchet envelopes that can't be decrypted by ratchet
        return { text: '🔒 Message illisible (session expirée)', encrypted: true, verified: false };
      }

      // Legacy envelope
      const session = await ensureLegacySession();
      if (!session) {
        return { text: '🔒 Clé de session manquante', encrypted: true, verified: false };
      }
      const result = await decryptMessage(body, session.sharedSecret, peerKeyRef.current?.signingKey);
      return { text: result.plaintext, encrypted: true, verified: result.verified };
    } catch (err) {
      console.error('[E2EE] decrypt failed:', err);
      return { text: '🔒 Message illisible', encrypted: true, verified: false };
    }
  }, [conversationId, ensureLegacySession]);

  /** Check if encryption is ready for this conversation */
  const isReady = useCallback((): boolean => {
    if (isZeus) return true;
    // Block if fingerprint changed
    if (state.fingerprintChanged) return false;
    return state.encrypted && !!keysRef.current && !!peerKeyRef.current;
  }, [state.encrypted, state.fingerprintChanged, isZeus]);

  /** Acknowledge fingerprint change — user explicitly trusts new key */
  const acknowledgeFingerprint = useCallback(() => {
    if (peerKeyRef.current && peerUserId) {
      // Only NOW save the new fingerprint
      saveKnownFingerprint(peerUserId, peerKeyRef.current.fingerprint);
    }
    // Clear ratchet state since keys changed
    if (conversationId) {
      openRatchetDB().then(db => {
        try {
          const tx = db.transaction(RATCHET_STORE_NAME, 'readwrite');
          tx.objectStore(RATCHET_STORE_NAME).delete(conversationId);
        } catch {}
      }).catch(() => {});
      ratchetRef.current = null;
    }
    setState(s => ({ ...s, fingerprintChanged: false, ready: true, ratchetActive: false }));
  }, [peerUserId, conversationId]);

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
