/**
 * useE2EE - React hook for End-to-End Encryption (v6 — Mode-Tagged & Robust)
 * 
 * SECURITY GUARANTEES:
 * - encrypt() NEVER returns plaintext — throws on failure
 * - decrypt() NEVER shows raw ciphertext — shows explicit error states
 * - Fingerprint changes are detected and BLOCK communication until acknowledged
 * - verified=true ONLY when signature is cryptographically verified
 * 
 * ARCHITECTURE (v6 — Mode-Tagged Payloads):
 * - Every encrypted payload carries an explicit `encryptionMode` field:
 *   "ratchet" or "legacy"
 * - Decrypt dispatches to the correct decryption path — NO blind fallback
 * - Primary: Double Ratchet (X25519 DH ratchet + symmetric KDF chain)
 * - Fallback: Legacy session (X25519 ECDH → HKDF → AES-256-GCM)
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
  saveSessionKey,
  incrementSessionMessageCount,
  needsKeyRotation,
  rotateSessionKey,
  initRatchetAsInitiator,
  initRatchetAsResponder,
  ratchetEncrypt,
  ratchetDecrypt,
  serializeRatchetState,
  deserializeRatchetState,
  getRatchetReadiness,
  isRatchetReadyForEncrypt,
  isRatchetReadyForDecrypt,
  generateAndUploadPrekeys,
  refillPrekeysIfNeeded,
  consumePeerPrekey,
  deriveFromOwnPrekey,
  // X3DH
  x3dhInitiate,
  x3dhRespond,
  fetchPrekeyBundle,
  generateAndUploadSignedPrekey,
  refreshSignedPrekeyIfNeeded,
  type IdentityKeyPair,
  type RatchetState,
  type RatchetEnvelope,
  type X3DHInitialMessage,
} from '@/lib/crypto';
import { base64ToBuffer, bufferToBase64 } from '@/lib/crypto/utils';
import { cryptoRateCheck } from '@/lib/crypto/rateLimiter';
import { verifyCryptoIntegrity, isTampered, hardGlobals, hardCrypto } from '@/lib/crypto/cryptoIntegrity';
import { DB_NAME, DB_VERSION, KX_KEY_PARAMS } from '@/lib/crypto/constants';

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

function recreateLegacyE2EEDatabase(): Promise<void> {
  return new Promise((resolve) => {
    try {
      const deleteRequest = hardGlobals.idbOpen(DB_NAME, DB_VERSION);
      deleteRequest.onsuccess = () => {
        try {
          deleteRequest.result.close();
        } catch {}
        const deletion = indexedDB.deleteDatabase(DB_NAME);
        deletion.onsuccess = () => resolve();
        deletion.onerror = () => resolve();
        deletion.onblocked = () => resolve();
      };
      deleteRequest.onerror = () => resolve();
      deleteRequest.onupgradeneeded = () => {
        try {
          deleteRequest.transaction?.abort();
        } catch {}
        const deletion = indexedDB.deleteDatabase(DB_NAME);
        deletion.onsuccess = () => resolve();
        deletion.onerror = () => resolve();
        deletion.onblocked = () => resolve();
      };
    } catch {
      try {
        const deletion = indexedDB.deleteDatabase(DB_NAME);
        deletion.onsuccess = () => resolve();
        deletion.onerror = () => resolve();
        deletion.onblocked = () => resolve();
      } catch {
        resolve();
      }
    }
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

// ─── Fingerprint verification (server-backed + local cache) ───

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
  localStorage.setItem(KNOWN_FP_KEY, hardGlobals.jsonStringify(known));
}

/** Save fingerprint to server for cross-device verification */
async function saveKnownFingerprintServer(peerUserId: string, fp: string) {
  try {
    await supabase
      .from('user_known_fingerprints')
      .upsert({
        user_id: (await supabase.auth.getUser()).data.user?.id,
        peer_user_id: peerUserId,
        fingerprint: fp,
        last_seen_at: new Date().toISOString(),
        acknowledged: true,
      }, { onConflict: 'user_id,peer_user_id' });
  } catch (e) {
    console.warn('[E2EE] Server fingerprint save failed:', e);
  }
}

/** Check fingerprint against both local AND server records */
async function checkFingerprintChangeWithServer(
  currentUserId: string,
  peerUserId: string,
  currentFp: string
): Promise<{ changed: boolean; previousFp: string | null }> {
  const known = getKnownFingerprints();
  const localPrevious = known[peerUserId];
  if (localPrevious && localPrevious !== currentFp) {
    return { changed: true, previousFp: localPrevious };
  }

  try {
    const { data } = await supabase
      .from('user_known_fingerprints')
      .select('fingerprint')
      .eq('user_id', currentUserId)
      .eq('peer_user_id', peerUserId)
      .maybeSingle();

    if (data && data.fingerprint !== currentFp) {
      console.warn('[PEER_KEY] ⚠️ Server-side fingerprint mismatch for', peerUserId);
      return { changed: true, previousFp: data.fingerprint };
    }
  } catch {
  }

  return { changed: false, previousFp: null };
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
      const req = hardGlobals.idbOpen(RATCHET_DB_NAME, RATCHET_DB_VERSION);
      req.onsuccess = () => {
        try {
          const db = req.result;
          const tx = db.transaction(RATCHET_STORE_NAME, 'readwrite');
          tx.objectStore(RATCHET_STORE_NAME).clear();
          console.log('[E2EE] Cleared stale ratchet states (migration v4)');
        } catch {}
      };
      // Also clear legacy session keys to re-derive
      const req2 = hardGlobals.idbOpen(DB_NAME, DB_VERSION);
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

// ─── Ratchet readiness check ───

/** Returns true only if the ratchet state is fully ready for encryption */
function isRatchetFullyReady(state: RatchetState | null): boolean {
  return isRatchetReadyForEncrypt(state);
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
  const prekeyInfoRef = useRef<{ prekeyId: number; senderPublicKey: string } | null>(null);
  const x3dhInfoRef = useRef<X3DHInitialMessage | null>(null);
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

      // Generate prekeys + signed prekeys if needed (Signal/X3DH-style)
      Promise.all([
        refillPrekeysIfNeeded(user.id),
        refreshSignedPrekeyIfNeeded(user.id, keys.signingPrivateKey),
      ]).catch(e => 
        console.warn('[E2EE] Prekey/SPK refill failed:', e)
      );

      // Auto-scrub: once keys are loaded into memory as non-extractable CryptoKeys,
      // delete raw JWKs from IndexedDB if PIN wrap is active (keys already protected)
      import('@/lib/crypto/pinWrap').then(async ({ hasWrappedKeys }) => {
        const hasWrap = await hasWrappedKeys(user.id);
        if (hasWrap) {
          const { deleteRawIdentityKeys } = await import('@/lib/crypto/keyManager');
          const { hasRawIdentityKeys } = await import('@/lib/crypto/keyManager');
          if (await hasRawIdentityKeys(user.id)) {
            await deleteRawIdentityKeys(user.id);
            console.log('[E2EE] Auto-scrubbed raw JWKs (PIN wrap active)');
          }
        }
      }).catch(() => {});

      setState(s => ({
        ...s,
        fingerprint: bundle.fingerprint,
        initError: null,
        ready: s.ready || s.encrypted,
      }));
      console.log('[E2EE] Keys initialized & published (with prekeys)');
    } catch (err) {
      console.error('[E2EE] Init failed:', err);
      const isMissingStoreError = err instanceof DOMException && err.name === 'NotFoundError';
      if (isMissingStoreError) {
        console.warn('[E2EE] Legacy IndexedDB schema detected, recreating local E2EE stores');
        await recreateLegacyE2EEDatabase();
        initRef.current = false;
        keysRef.current = null;
        peerKeyRef.current = null;
        ratchetRef.current = null;
        prekeyInfoRef.current = null;
        x3dhInfoRef.current = null;
        legacySessionReadyRef.current = false;
        setState(s => ({
          ...s,
          ready: false,
          encrypted: false,
          ratchetActive: false,
          fingerprint: null,
          peerFingerprint: null,
          fingerprintChanged: false,
          peerKeyMissing: false,
          initError: null,
        }));
        queueMicrotask(() => {
          if (!initRef.current) {
            initRef.current = true;
            void initKeys();
          }
        });
        return;
      }
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

          // Check for fingerprint change — server-backed + local
          const { changed: fpChanged } = await checkFingerprintChangeWithServer(user.id, peerUserId, data.fingerprint);

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

          // Save fingerprint both locally and server-side
          saveKnownFingerprint(peerUserId, data.fingerprint);
          saveKnownFingerprintServer(peerUserId, data.fingerprint);

          // Pre-establish legacy session immediately
          if (keysRef.current && conversationId) {
            try {
              let session = await loadSessionKey(conversationId);
              if (cancelled) return;
              if (!session) {
                session = await establishSession(keysRef.current, data.identity_key, conversationId, data.fingerprint);
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
            ready: true,
            ratchetActive: false,
            fingerprintChanged: false,
            peerKeyMissing: false,
            initError: null,
          }));
        } else {
          console.log('[PEER_KEY] No identity key found for', peerUserId, '— trying prekey exchange');

          // Try prekey-based key exchange (Signal-style)
          if (keysRef.current && conversationId) {
            try {
              const result = await consumePeerPrekey(
                keysRef.current.privateKey,
                peerUserId,
                conversationId,
              );
              if (result && !cancelled) {
                // Store as a session key for this conversation
                const { saveSessionKey } = await import('@/lib/crypto/keyManager');
                await saveSessionKey({
                  conversationId,
                  sharedSecret: result.sharedSecret,
                  messageCount: 0,
                  createdAt: Date.now(),
                  peerFingerprint: `prekey:${result.prekeyId}`,
                });
                legacySessionReadyRef.current = true;

                // Export our public key so peer can derive the same secret
                const ourPublicRaw = await hardCrypto.exportKey('raw', keysRef.current.publicKey);
                prekeyInfoRef.current = {
                  prekeyId: result.prekeyId,
                  senderPublicKey: bufferToBase64(ourPublicRaw),
                };

                setState(s => ({
                  ...s,
                  encrypted: true,
                  ready: true,
                  peerKeyMissing: false,
                  initError: null,
                }));
                console.log('[PEER_KEY] ✅ Prekey exchange successful — encrypted mode');
                return;
              }
            } catch (prekeyErr) {
              console.warn('[PEER_KEY] Prekey exchange failed:', prekeyErr);
            }
          }

          // No identity key AND no prekeys — encryption impossible, BLOCK sending
          console.warn('[PEER_KEY] ⛔ No encryption possible for', peerUserId);
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

  // Legacy session — load existing or establish new (NEVER rotates — rotation is encrypt-only)
  const ensureLegacySession = useCallback(async () => {
    if (!conversationId || !keysRef.current || !peerKeyRef.current) return null;
    let session = await loadSessionKey(conversationId);
    if (!session) {
      session = await establishSession(keysRef.current, peerKeyRef.current.identityKey, conversationId, peerKeyRef.current.fingerprint);
    }
    return session;
  }, [conversationId]);

  /**
   * Initialize Double Ratchet as initiator (sender of first ratchet message).
   * Uses X3DH for key agreement (3 or 4 DH operations) then seeds Double Ratchet.
   * Falls back to legacy DH if X3DH bundle is unavailable.
   */
  const initRatchetIfNeeded = useCallback(async (): Promise<RatchetState | null> => {
    if (!conversationId || !keysRef.current || !peerKeyRef.current || !peerUserId) return null;

    // Already have a ratchet? Use it only if fully ready
    if (ratchetRef.current) {
      if (isRatchetFullyReady(ratchetRef.current)) {
        return ratchetRef.current;
      }
      // Ratchet exists but not fully ready (e.g. responder waiting for first msg)
      // Don't use it for encryption — let legacy handle it
      console.debug('[E2EE] Ratchet exists but not fully ready for encryption — using legacy');
      return null;
    }

    // Try loading persisted ratchet
    const persisted = await loadRatchetLocal(conversationId);
    if (persisted) {
      if (isRatchetFullyReady(persisted)) {
        ratchetRef.current = persisted;
        return persisted;
      }
      // Persisted ratchet is incomplete — skip
      console.debug('[E2EE] Persisted ratchet incomplete — using legacy');
    }

    const initFromBundle = async (bundle: Awaited<ReturnType<typeof fetchPrekeyBundle>>) => {
      if (!bundle || !keysRef.current) return null;

      const x3dhResult = await x3dhInitiate(keysRef.current, bundle);

      // Store X3DH metadata for the initial message header
      // IMPORTANT: Do NOT null this until the first message is confirmed sent
      const myPubRaw = await hardCrypto.exportKey('raw', keysRef.current.publicKey);
      x3dhInfoRef.current = {
        ik: bufferToBase64(myPubRaw),
        ek: x3dhResult.ephemeralKey,
        spkId: x3dhResult.usedSPKId,
        opkId: x3dhResult.usedOTPKId,
        kemCt: x3dhResult.kemCiphertext,
      };

      // Import peer SPK as DH ratchet key for Double Ratchet init
      // Per Signal spec: Alice uses Bob's SPK as the initial remote ratchet key
      const peerSPKKey = await hardCrypto.importKey(
        'raw', base64ToBuffer(bundle.signedPrekey),
        KX_KEY_PARAMS as any, true, [],
      );

      const ratchet = await initRatchetAsInitiator(
        conversationId,
        x3dhResult.sharedSecret,
        peerSPKKey,
      );

      const readiness = getRatchetReadiness(ratchet);
      if (!readiness.canEncrypt) {
        console.debug('[E2EE] Ratchet initialized but not encrypt-ready:', readiness.reason);
        return null;
      }

      ratchetRef.current = ratchet;
      await saveRatchetLocal(conversationId, ratchet);
      console.log('[E2EE] 🔄 Double Ratchet initialized via X3DH (initiator)');
      return ratchet;
    };

    // X3DH key agreement (Signal spec)
    try {
      // fetchPrekeyBundle now validates SPK signature BEFORE consuming OPK
      const bundle = await fetchPrekeyBundle(peerUserId);
      if (bundle) {
        return await initFromBundle(bundle);
      } else {
        console.info('[E2EE] No valid X3DH bundle available for peer — using legacy');
      }
    } catch (x3dhErr) {
      console.warn('[E2EE] X3DH init failed:', 
        x3dhErr instanceof Error ? x3dhErr.message : String(x3dhErr));
    }

    // Legacy fallback — session keys are non-extractable, skip ratchet
    return null;
  }, [conversationId, ensureLegacySession, peerUserId]);

  /**
   * Encrypt — NEVER returns plaintext.
   * PRIMARY: Double Ratchet (per-message forward secrecy) — only when ratchet is FULLY READY.
   * FALLBACK: Legacy session (deterministic AES-GCM).
   * Throws EncryptionError if all paths fail.
   * 
   * CRITICAL: Every payload now carries `encryptionMode` for deterministic decryption routing.
   */
  const encrypt = useCallback(async (plaintext: string): Promise<string> => {
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

    // If peer has no identity key but we have a prekey-based session, use it
    if (!peerKeyRef.current && !legacySessionReadyRef.current) {
      throw new EncryptionError('🔒 Chiffrement impossible — le contact n\'a pas encore de clés. Le message sera envoyé dès qu\'il se connectera.');
    }

    if (!cryptoRateCheck('encrypt')) {
      throw new EncryptionError('Rate limited — possible exfiltration attempt');
    }

    // PRIMARY: Double Ratchet with X3DH — only if ratchet is FULLY READY
    if (peerKeyRef.current) {
      try {
        const ratchet = await initRatchetIfNeeded();
        const readiness = getRatchetReadiness(ratchet);
        if (ratchet && readiness.canEncrypt) {
          const { envelope, newState } = await ratchetEncrypt(
            ratchet,
            plaintext,
            keysRef.current.signingPrivateKey,
            keysRef.current.fingerprint,
          );
          ratchetRef.current = newState;
          await saveRatchetLocal(conversationId!, newState);
          setState(s => ({ ...s, ratchetActive: true }));

          // Tag with encryption mode
          const taggedEnvelope = envelope as any;
          taggedEnvelope.encryptionMode = 'ratchet';

          // Attach X3DH header to the FIRST message so responder can derive the same SK
          if (x3dhInfoRef.current) {
            taggedEnvelope.x3dh = x3dhInfoRef.current;
            x3dhInfoRef.current = null; // Only attach once
            console.log('[E2EE] ✅ encrypt via X3DH + Double Ratchet (initial message)');
          } else {
            console.log('[E2EE] ✅ encrypt via Double Ratchet (forward secrecy)');
          }
          return hardGlobals.jsonStringify(taggedEnvelope);
        }

        if (ratchet) {
          console.debug('[E2EE] Ratchet not ready for encrypt, using legacy:', readiness.reason);
        }
      } catch (ratchetErr) {
        // Ratchet not ready or failed — fall through to legacy silently
        console.debug('[E2EE] Ratchet not available, using legacy:', 
          ratchetErr instanceof Error ? ratchetErr.message : String(ratchetErr));
      }
    }

    // FALLBACK: Legacy or prekey-based session (AES-GCM)
    try {
      let session = peerKeyRef.current ? await ensureLegacySession() : await loadSessionKey(conversationId!);
      if (!session) {
        throw new EncryptionError('No encryption session available');
      }

      // Rotate key if needed ONLY on encrypt path (never on decrypt)
      if (peerKeyRef.current && await needsKeyRotation(conversationId!)) {
        session = await rotateSessionKey(keysRef.current, peerKeyRef.current.identityKey, conversationId!, peerKeyRef.current.fingerprint);
        console.log('[E2EE] 🔄 Session key rotated for forward secrecy');
      }

      const seq = await incrementSessionMessageCount(conversationId!);
      let result = await encryptMessage(
        plaintext, session.sharedSecret,
        keysRef.current.signingPrivateKey, keysRef.current.fingerprint, seq,
      );

      // Tag with encryption mode
      const parsed = hardGlobals.jsonParse(result);
      parsed.encryptionMode = 'legacy';

      // If this is a prekey-based message, wrap with prekey metadata so receiver can derive
      if (prekeyInfoRef.current && !peerKeyRef.current) {
        parsed.prekey = {
          id: prekeyInfoRef.current.prekeyId,
          senderKey: prekeyInfoRef.current.senderPublicKey,
        };
        console.log('[E2EE] ✅ encrypt via prekey session (first contact)');
      } else {
        console.log('[E2EE] ✅ encrypt via legacy session');
      }
      return hardGlobals.jsonStringify(parsed);
    } catch (err) {
      if (err instanceof EncryptionError) throw err;
      console.error('[E2EE] ❌ Encrypt failed:', err);
      throw new EncryptionError(`Encryption failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [state.fingerprintChanged, conversationId, user, ensureLegacySession, initRatchetIfNeeded]);

  /**
   * Decrypt — NEVER shows raw ciphertext.
   * Uses `encryptionMode` tag for deterministic dispatch.
   * For legacy messages without the tag, falls back to heuristic detection.
   */
  const decrypt = useCallback(async (body: string): Promise<{ text: string; encrypted: boolean; verified: boolean }> => {
    if (!isEncryptedMessage(body) && !isRatchetEnvelope(body)) {
      return { text: body, encrypted: false, verified: false };
    }

    if (!cryptoRateCheck('decrypt')) {
      return { text: '🔒 Opération limitée (sécurité)', encrypted: true, verified: false };
    }

    try {
      const parsed = hardGlobals.jsonParse(body);
      const explicitMode: string | undefined = parsed.encryptionMode;

      // ── Deterministic dispatch based on encryptionMode tag ──

      if (explicitMode === 'ratchet') {
        // ONLY attempt ratchet decryption
        return await decryptRatchetMessage(parsed, body);
      }

      if (explicitMode === 'legacy') {
        // ONLY attempt legacy decryption
        return await decryptLegacyMessage(parsed, body);
      }

      // ── No encryptionMode tag: backward-compatible heuristic ──
      // Old messages before v6 don't have the tag

      if (isRatchetEnvelope(body)) {
        // Looks like a ratchet envelope (has v, hdr, ct fields)
        const result = await decryptRatchetMessage(parsed, body);
        if (result.text !== '🔒 Message illisible (session expirée)') {
          return result;
        }
        // If ratchet failed on an untagged message, try legacy as last resort
        console.debug('[E2EE] Untagged ratchet envelope failed — trying legacy fallback');
        try {
          return await decryptLegacyMessage(parsed, body);
        } catch {
          return result; // Return the ratchet error
        }
      }

      // Legacy envelope (has ct but no hdr)
      return await decryptLegacyMessage(parsed, body);

    } catch (err) {
      console.error('[E2EE] decrypt failed:', err);
      return { text: '🔒 Message chiffré', encrypted: true, verified: false };
    }
  }, [conversationId, user]);

  /** Decrypt a ratchet-mode message */
  const decryptRatchetMessage = useCallback(async (
    parsed: any,
    rawBody: string,
  ): Promise<{ text: string; encrypted: boolean; verified: boolean }> => {
    const envelope: RatchetEnvelope = parsed;
    const x3dhHeader: X3DHInitialMessage | undefined = parsed.x3dh;
    let ratchet = ratchetRef.current;

    // Auto-init ratchet as responder if we don't have one yet
    if (!ratchet && conversationId && keysRef.current && user) {
      try {
        const persisted = await loadRatchetLocal(conversationId);
        if (persisted) {
          ratchet = persisted;
          ratchetRef.current = ratchet;
        } else if (x3dhHeader) {
          // X3DH responder: derive shared secret from the X3DH header
          const { sharedSecret, responderDhKey } = await x3dhRespond(
            keysRef.current,
            user.id,
            x3dhHeader,
          );
          const ourDhPair = await hardCrypto.generateKey(
            KX_KEY_PARAMS as any, true, ['deriveBits']
          ) as CryptoKeyPair;
          ratchet = await initRatchetAsResponder(
            conversationId, sharedSecret, ourDhPair,
          );
          ratchet.dhReceivingKey = responderDhKey;
          ratchetRef.current = ratchet;
          console.log('[E2EE] 🔄 Double Ratchet initialized via X3DH (responder)');
        } else {
          // Fallback: legacy shared secret as seed
          const session = await ensureLegacySession();
          if (session) {
            const sharedSecretRaw = await hardCrypto.exportKey('raw', session.sharedSecret);
            const ourDhPair = await hardCrypto.generateKey(
              KX_KEY_PARAMS as any, true, ['deriveBits']
            ) as CryptoKeyPair;
            ratchet = await initRatchetAsResponder(
              conversationId, sharedSecretRaw, ourDhPair,
            );
            ratchetRef.current = ratchet;
            console.log('[E2EE] 🔄 Double Ratchet initialized as responder (legacy fallback)');
          }
        }
      } catch (initErr) {
        console.warn('[E2EE] Ratchet responder init failed:', initErr);
      }
    }

    if (ratchet) {
      const readiness = getRatchetReadiness(ratchet);
      if (!readiness.canDecrypt) {
        console.debug('[E2EE] Ratchet state not decrypt-ready:', readiness.reason);
        return { text: '🔒 Message illisible (session expirée)', encrypted: true, verified: false };
      }

      try {
        const { plaintext, verified, newState } = await ratchetDecrypt(
          ratchet, envelope, peerKeyRef.current?.signingKey,
        );
        ratchetRef.current = newState;
        await saveRatchetLocal(conversationId!, newState);
        setState(s => ({ ...s, ratchetActive: true }));
        return { text: plaintext, encrypted: true, verified };
      } catch (ratchetErr) {
        console.debug('[E2EE] Ratchet decrypt failed:', 
          ratchetErr instanceof Error ? ratchetErr.message : String(ratchetErr));
      }
    }

    return { text: '🔒 Message illisible (session expirée)', encrypted: true, verified: false };
  }, [conversationId, user, ensureLegacySession]);

  /** Decrypt a legacy-mode message */
  const decryptLegacyMessage = useCallback(async (
    parsed: any,
    rawBody: string,
  ): Promise<{ text: string; encrypted: boolean; verified: boolean }> => {
    // Handle prekey-based messages (receiver side)
    if (parsed.prekey && user && conversationId) {
      try {
        const prekeySecret = await deriveFromOwnPrekey(
          user.id,
          parsed.prekey.id,
          parsed.prekey.senderKey,
          conversationId,
        );
        if (prekeySecret) {
          const result = await decryptMessage(rawBody, prekeySecret, peerKeyRef.current?.signingKey);
          return { text: result.plaintext, encrypted: true, verified: result.verified };
        }
      } catch (prekeyErr) {
        console.warn('[E2EE] Prekey decrypt failed:', prekeyErr);
      }
    }

    // Standard legacy session — load only, NEVER rotate on decrypt
    let session = peerKeyRef.current ? await ensureLegacySession() : await loadSessionKey(conversationId!);
    if (!session) {
      return { text: '🔒 Clé de session manquante', encrypted: true, verified: false };
    }

    try {
      const result = await decryptMessage(rawBody, session.sharedSecret, peerKeyRef.current?.signingKey);
      return { text: result.plaintext, encrypted: true, verified: result.verified };
    } catch {
      return { text: '🔒 Message chiffré (clé expirée)', encrypted: true, verified: false };
    }
  }, [conversationId, user, ensureLegacySession]);

  /** Check if encryption is ready for this conversation */
  const isReady = useCallback((): boolean => {
    if (isZeus) return true;
    // Block if fingerprint changed
    if (state.fingerprintChanged) return false;
    // Ready if we have identity-based or prekey-based encryption
    return state.encrypted && !!keysRef.current && (!!peerKeyRef.current || legacySessionReadyRef.current);
  }, [state.encrypted, state.fingerprintChanged, isZeus]);

  /** Acknowledge fingerprint change — user explicitly trusts new key */
  const acknowledgeFingerprint = useCallback(() => {
    if (peerKeyRef.current && peerUserId) {
      // Save new fingerprint locally AND server-side
      saveKnownFingerprint(peerUserId, peerKeyRef.current.fingerprint);
      saveKnownFingerprintServer(peerUserId, peerKeyRef.current.fingerprint);
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
    const p = hardGlobals.jsonParse(body);
    return p.v !== undefined && p.hdr !== undefined && p.ct !== undefined;
  } catch {
    return false;
  }
}
