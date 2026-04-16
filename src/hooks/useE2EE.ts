/**
 * useE2EE - React hook for End-to-End Encryption (v6 — Mode-Tagged & Robust)
 * 
 * SECURITY GUARANTEES:
 * - encrypt() NEVER returns plaintext — throws on failure
 * - decrypt() NEVER shows raw ciphertext — shows explicit error states
 * - Fingerprint changes are detected and BLOCK communication until acknowledged
 * - verified=true ONLY when signature is cryptographically verified
 * 
 * ARCHITECTURE (v7 — Ratchet-Only Outbound, Mode-Tagged Payloads):
 * - Every encrypted payload carries an explicit `encryptionMode` field:
 *   "ratchet" or "legacy"
 * - Decrypt dispatches to the correct decryption path — NO blind fallback
 * - Primary: Double Ratchet (X25519 DH ratchet + symmetric KDF chain)
 * - Legacy session ONLY used for inbound decrypt of old messages (never outbound)
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
  reconcilePrekeysWithServer,
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
import { PinUnlockRequiredError } from '@/lib/crypto/keyManager';
import { base64ToBuffer, bufferToBase64 } from '@/lib/crypto/utils';
import { cryptoRateCheck } from '@/lib/crypto/rateLimiter';
import { verifyCryptoIntegrity, isTampered, hardGlobals, hardCrypto } from '@/lib/crypto/cryptoIntegrity';
import { KX_KEY_PARAMS, STORE_PREKEYS, STORE_SESSION } from '@/lib/crypto/constants';
import { openE2EEDB } from '@/lib/crypto/indexedDb';

const ZEUS_ID = '00000000-0000-0000-0000-000000000001';
const RATCHET_DB_NAME = 'forsure-ratchet';
const RATCHET_DB_VERSION = 1;
const RATCHET_STORE_NAME = 'ratchet-states';
const KNOWN_FP_KEY = 'forsure-known-fps';

// Deduplication lock for ensureKeysAndPeerSync — prevents concurrent calls
// from firing dozens of identical API requests
let _peerSyncPromise: Map<string, Promise<boolean>> = new Map();

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
    void (async () => {
      try {
        const db = await openE2EEDB();
        const storesToClear = [STORE_SESSION, STORE_PREKEYS].filter((store) => db.objectStoreNames.contains(store));

        if (storesToClear.length > 0) {
          const tx = db.transaction(storesToClear, 'readwrite');
          storesToClear.forEach((store) => tx.objectStore(store).clear());
          await new Promise<void>((txResolve, txReject) => {
            tx.oncomplete = () => txResolve();
            tx.onerror = () => txReject(tx.error);
          });
          console.log('[E2EE] Repaired IndexedDB schema and cleared transient crypto stores');
        }

        db.close();
      } catch (error) {
        console.error('[E2EE] Failed to repair E2EE database — identity keys preserved', error);
      } finally {
        resolve();
      }
    })();
  });
}

async function saveRatchetLocal(convId: string, state: RatchetState, x3dhHeader?: X3DHInitialMessage | null) {
  try {
    const json = await serializeRatchetState(state);
    const db = await openRatchetDB();
    const tx = db.transaction(RATCHET_STORE_NAME, 'readwrite');
    const record: any = { convId, data: json };
    // Persist X3DH header alongside ratchet state (Signal: attach PreKey header until first peer response)
    if (x3dhHeader !== undefined) {
      record.x3dhHeader = x3dhHeader ? hardGlobals.jsonStringify(x3dhHeader) : null;
    }
    tx.objectStore(RATCHET_STORE_NAME).put(record);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('[E2EE] Failed to persist ratchet state:', e);
  }
}

async function loadRatchetLocal(convId: string): Promise<{ state: RatchetState; x3dhHeader: X3DHInitialMessage | null } | null> {
  try {
    const db = await openRatchetDB();
    const tx = db.transaction(RATCHET_STORE_NAME, 'readonly');
    const req = tx.objectStore(RATCHET_STORE_NAME).get(convId);
    const result = await new Promise<any>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!result?.data) return null;
    const state = await deserializeRatchetState(result.data);
    const x3dhHeader = result.x3dhHeader ? hardGlobals.jsonParse(result.x3dhHeader) as X3DHInitialMessage : null;
    return { state, x3dhHeader };
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

/** Save fingerprint to server for cross-device verification (deduplicated) */
const _fpSaveCache = new Map<string, number>();
async function saveKnownFingerprintServer(peerUserId: string, fp: string) {
  // Deduplicate: skip if same fp was saved in the last 60s
  const cacheKey = `${peerUserId}:${fp}`;
  const lastSaved = _fpSaveCache.get(cacheKey);
  if (lastSaved && Date.now() - lastSaved < 60_000) return;
  _fpSaveCache.set(cacheKey, Date.now());

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

/** Check fingerprint against both local AND server records (with cache) */
const _fpCheckCache = new Map<string, { result: { changed: boolean; previousFp: string | null }; ts: number }>();
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
      // Also clear legacy session keys to re-derive — use openE2EEDB to ensure stores exist
      openE2EEDB().then(db => {
        try {
          if (db.objectStoreNames.contains(STORE_SESSION)) {
            const tx = db.transaction(STORE_SESSION, 'readwrite');
            tx.objectStore(STORE_SESSION).clear();
            console.log('[E2EE] Cleared stale session keys (migration v4)');
          }
          db.close();
        } catch {}
      }).catch(() => {});
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
  const pendingPayloadRef = useRef<Map<string, string>>(new Map());
  const prekeyInfoRef = useRef<{ prekeyId: number; senderPublicKey: string } | null>(null);
  const x3dhInfoRef = useRef<X3DHInitialMessage | null>(null);
  const initRef = useRef(false);
  const legacySessionReadyRef = useRef(false);
  const peerHasRespondedRef = useRef(false);

  const isZeus = peerUserId === ZEUS_ID;

  // Initialize identity keys + publish
  const initKeys = useCallback(async () => {
    if (!user) return;
    try {
      const keysResult = await getOrCreateIdentityKeys(user.id);
      const isNewIdentity = !!(keysResult as any).isNewIdentity;
      const keys: IdentityKeyPair = keysResult;
      keysRef.current = keys;

      const bundle = await exportPublicKeyBundle(keys);

      // Check server state BEFORE publishing
      const { data: existingServerKey } = await supabase
        .from('user_public_keys')
        .select('fingerprint, identity_key')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .maybeSingle();

      if (isNewIdentity && existingServerKey) {
        // IDENTITY LOSS DETECTED: local keys were regenerated but server has old keys.
        // Check if an encrypted backup exists — if so, require restore instead of overwriting.
        const { data: backupData } = await supabase
          .from('user_backups' as any)
          .select('id')
          .eq('user_id', user.id)
          .maybeSingle();

        if (backupData) {
          console.error(
            '[E2EE] ⛔ Identity loss detected! Server fingerprint:',
            existingServerKey.fingerprint,
            '— Encrypted backup exists. Requesting restore before continuing.'
          );
          setState(s => ({
            ...s,
            ready: false,
            initError: 'identity_lost_backup_available',
          }));
          // Dispatch event so UI can show restore dialog
          window.dispatchEvent(new CustomEvent('forsure-identity-lost', {
            detail: { hasBackup: true, serverFingerprint: existingServerKey.fingerprint }
          }));
          return;
        }

        // No backup exists — this is a genuine new identity (first device, or user accepted loss)
        console.warn(
          '[E2EE] ⚠️ New identity created (no backup found). Server keys will be replaced.',
          `Old: ${existingServerKey.fingerprint}`,
          `New: ${bundle.fingerprint}`
        );
      }

      // Publish keys to server
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

      // Push updated fingerprint to peers who cached a stale one
      supabase.rpc('push_my_fingerprint_to_peers').then(({ data: updated }) => {
        if (updated && (updated as number) > 0) console.log('[E2EE] Pushed fingerprint to', updated, 'peer(s)');
      });

      // Generate prekeys + signed prekeys if needed (Signal/X3DH-style)
      Promise.all([
        reconcilePrekeysWithServer(user.id),
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
      // Handle PIN unlock required (keys exist wrapped, need PIN)
      if (err instanceof PinUnlockRequiredError) {
        console.log('[E2EE] PIN unlock required to recover identity keys');
        setState(s => ({
          ...s,
          ready: false,
          initError: 'pin_unlock_required',
        }));
        window.dispatchEvent(new CustomEvent('forsure-pin-required-for-keys'));
        return;
      }

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

  useEffect(() => {
    const handler = () => {
      console.log('[E2EE] Keys locked via PIN — clearing in-memory crypto state');
      keysRef.current = null;
      ratchetRef.current = null;
      prekeyInfoRef.current = null;
      x3dhInfoRef.current = null;
      legacySessionReadyRef.current = false;
      peerHasRespondedRef.current = false;
      pendingPayloadRef.current.clear();
      setState(s => ({
        ...s,
        ready: false,
        ratchetActive: false,
        initError: null,
      }));
    };
    window.addEventListener('forsure-keys-locked', handler);
    return () => window.removeEventListener('forsure-keys-locked', handler);
  }, []);

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
          
          // Push updated fingerprint to all peers who have a stale copy
          supabase.rpc('push_my_fingerprint_to_peers').then(({ data: updated }) => {
            if (updated && (updated as number) > 0) console.log('[E2EE] Pushed fingerprint to', updated, 'peer(s)');
          });
          
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

          // STRICT MODE: If fingerprint changed, BLOCK sending until user explicitly acknowledges.
          // Do NOT auto-accept — this is the core MITM/key-replacement detection.
          if (fpChanged) {
            console.warn('[PEER_KEY] 🛑 Fingerprint changed for', peerUserId, '— BLOCKING until user acknowledges');
            
            peerKeyRef.current = {
              identityKey: data.identity_key,
              signingKey: data.signing_key,
              fingerprint: data.fingerprint,
            };

            // Clear old crypto state but do NOT re-establish session
            if (conversationId) {
              openRatchetDB().then(db => {
                try {
                  const tx = db.transaction(RATCHET_STORE_NAME, 'readwrite');
                  tx.objectStore(RATCHET_STORE_NAME).delete(conversationId);
                } catch {}
              }).catch(() => {});
              ratchetRef.current = null;
              peerHasRespondedRef.current = false;
              x3dhInfoRef.current = null;
              pendingPayloadRef.current.clear();
              legacySessionReadyRef.current = false;
            }
            
            // Set fingerprintChanged=true AND ready=false to BLOCK sending
            setState(s => ({
              ...s,
              peerFingerprint: data.fingerprint,
              encrypted: true,
              ready: false,
              fingerprintChanged: true,
              peerKeyMissing: false,
              ratchetActive: false,
              initError: 'fingerprint_changed',
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
          console.log('[PEER_KEY] No identity key found for', peerUserId, '— peer may not have published keys yet');

          // No identity key found — mark as temporarily unavailable but allow retry
          // The peer may come online and publish their keys later
          console.warn('[PEER_KEY] ⚠️ No public keys for', peerUserId, '— will retry on next open');
          setState(s => ({
            ...s,
            encrypted: false,
            ready: false,
            peerKeyMissing: true,
          }));
        }
      } catch (err) {
        console.error('[E2EE] Peer key fetch failed:', err);
        if (!cancelled) {
          setState(s => ({
            ...s,
            encrypted: false,
            ready: false,
            initError: 'Peer key fetch failed',
          }));
        }
      }
    })();

    return () => { cancelled = true; };
  }, [peerUserId, user, conversationId, isZeus]);

  // Retry peer key fetch when peerKeyMissing — contact may have come online
  useEffect(() => {
    if (!state.peerKeyMissing || !peerUserId || isZeus) return;
    const interval = setInterval(async () => {
      try {
        const { data } = await supabase
          .from('user_public_keys')
          .select('identity_key, signing_key, fingerprint')
          .eq('user_id', peerUserId)
          .eq('is_active', true)
          .maybeSingle();
        if (data) {
          console.log('[PEER_KEY] ✅ Peer keys now available — upgrading to encrypted mode');
          peerKeyRef.current = {
            identityKey: data.identity_key,
            signingKey: data.signing_key,
            fingerprint: data.fingerprint,
          };
          saveKnownFingerprint(peerUserId, data.fingerprint);
          saveKnownFingerprintServer(peerUserId, data.fingerprint);
          
          // Pre-establish legacy session
          if (keysRef.current && conversationId) {
            try {
              let session = await loadSessionKey(conversationId);
              if (!session) {
                session = await establishSession(keysRef.current, data.identity_key, conversationId, data.fingerprint);
              }
              legacySessionReadyRef.current = true;
            } catch {}
          }
          
          setState(s => ({
            ...s,
            peerFingerprint: data.fingerprint,
            encrypted: true,
            ready: true,
            peerKeyMissing: false,
          }));
        }
      } catch {}
    }, 10_000); // retry every 10s
    return () => clearInterval(interval);
  }, [state.peerKeyMissing, peerUserId, isZeus, conversationId]);

  // Legacy session — load existing or establish new (NEVER rotates — rotation is encrypt-only)
  const ensureLegacySession = useCallback(async () => {
    if (!conversationId || !keysRef.current || !peerKeyRef.current) return null;
    let session = await loadSessionKey(conversationId);
    if (!session) {
      session = await establishSession(keysRef.current, peerKeyRef.current.identityKey, conversationId, peerKeyRef.current.fingerprint);
    }
    return session;
  }, [conversationId]);

  const ensureKeysAndPeerSync = useCallback(async (forceSessionRefresh = false): Promise<boolean> => {
    if (!user || !peerUserId || isZeus) return false;

    if (!keysRef.current) {
      try {
        const keys = await getOrCreateIdentityKeys(user.id);
        keysRef.current = keys;
        setState(s => ({ ...s, fingerprint: s.fingerprint ?? keys.fingerprint }));
      } catch (error) {
        console.warn('[E2EE] Failed to recover local identity keys:', error);
        return false;
      }
    }

    if (peerKeyRef.current && !forceSessionRefresh) {
      return true;
    }

    try {
      const { data: freshPeerKey } = await supabase
        .from('user_public_keys')
        .select('identity_key, signing_key, fingerprint')
        .eq('user_id', peerUserId)
        .eq('is_active', true)
        .maybeSingle();

      if (!freshPeerKey) {
        setState(s => ({
          ...s,
          encrypted: false,
          ready: false,
          peerKeyMissing: true,
        }));
        return false;
      }

      const { changed: fingerprintChanged } = await checkFingerprintChangeWithServer(
        user.id,
        peerUserId,
        freshPeerKey.fingerprint,
      );

      peerKeyRef.current = {
        identityKey: freshPeerKey.identity_key,
        signingKey: freshPeerKey.signing_key,
        fingerprint: freshPeerKey.fingerprint,
      };

      saveKnownFingerprint(peerUserId, freshPeerKey.fingerprint);
      void saveKnownFingerprintServer(peerUserId, freshPeerKey.fingerprint);

      if (conversationId && (forceSessionRefresh || fingerprintChanged)) {
        try {
          const db = await openRatchetDB();
          const tx = db.transaction(RATCHET_STORE_NAME, 'readwrite');
          tx.objectStore(RATCHET_STORE_NAME).delete(conversationId);
          await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
          db.close();
        } catch {}

        ratchetRef.current = null;
        peerHasRespondedRef.current = false;
        x3dhInfoRef.current = null;
        pendingPayloadRef.current.clear();

        try {
          const { deleteSessionKey } = await import('@/lib/crypto/keyManager');
          await deleteSessionKey(conversationId);
        } catch {}
      }

      if (conversationId && keysRef.current) {
        try {
          await ensureLegacySession();
          legacySessionReadyRef.current = true;
        } catch (sessionError) {
          legacySessionReadyRef.current = false;
          console.warn('[E2EE] Session auto-repair failed:', sessionError);
        }
      }

      setState(s => ({
        ...s,
        peerFingerprint: freshPeerKey.fingerprint,
        encrypted: true,
        ready: true,
        ratchetActive: fingerprintChanged ? false : s.ratchetActive,
        fingerprintChanged,
        peerKeyMissing: false,
        initError: null,
      }));

      return true;
    } catch (error) {
      console.warn('[E2EE] Peer key sync failed:', error);
      return false;
    }
  }, [conversationId, ensureLegacySession, isZeus, peerUserId, user]);

  /**
   * Initialize Double Ratchet as initiator (sender of first ratchet message).
   * Uses X3DH for key agreement (3 or 4 DH operations) then seeds Double Ratchet.
   * Never falls back to legacy for outbound modern messages.
   */
  const initRatchetIfNeeded = useCallback(async (): Promise<RatchetState | null> => {
    if (!conversationId || !keysRef.current || !peerKeyRef.current || !peerUserId) return null;

    // Already have a ratchet? Use it only if fully ready
    if (ratchetRef.current) {
      if (isRatchetFullyReady(ratchetRef.current)) {
        return ratchetRef.current;
      }
      throw new EncryptionError('🔒 Session Double Ratchet incomplète — message en attente chiffrée');
    }

    // Try loading persisted ratchet + X3DH header
    const persisted = await loadRatchetLocal(conversationId);
    if (persisted) {
      if (isRatchetFullyReady(persisted.state)) {
        ratchetRef.current = persisted.state;
        // Restore X3DH header for Signal-style PreKey persistence across refresh
        if (persisted.x3dhHeader) {
          x3dhInfoRef.current = persisted.x3dhHeader;
          peerHasRespondedRef.current = false;
          console.info('[E2EE] Restored X3DH header from persistence (PreKey header will be re-attached)');
        }
        console.info('[E2EE] Loaded persisted ratchet — ready for encrypt');
        return persisted.state;
      }
      throw new EncryptionError('🔒 Session Double Ratchet persistée incomplète — message en attente chiffrée');
    }

    // X3DH key agreement (Signal spec) — NO legacy fallback
    console.info(`[X3DH] init initiator — fetching bundle for peer ${peerUserId}`);

    const bundle = await fetchPrekeyBundle(peerUserId);
    if (!bundle) {
      console.error('[X3DH] ⛔ Bundle pair absent, expiré ou incohérent — impossible d\'initialiser X3DH');
      throw new EncryptionError('🔒 Bundle X3DH du contact indisponible ou incohérent — message en attente chiffrée');
    }

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
    console.info(`[X3DH] init initiator — X3DH header stored (SPK #${x3dhResult.usedSPKId}, OPK ${x3dhResult.usedOTPKId ?? 'none'})`);

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
      throw new EncryptionError(`🔒 Double Ratchet non prêt pour l'envoi${readiness.reason ? ` (${readiness.reason})` : ''} — message en attente chiffrée`);
    }

    ratchetRef.current = ratchet;
    await saveRatchetLocal(conversationId, ratchet, x3dhInfoRef.current);
    console.info('[RATCHET] ✅ init with X3DH (initiator) — ready for encrypt');
    return ratchet;
  }, [conversationId, peerUserId]);

  /**
   * Encrypt — NEVER returns plaintext.
   * Uses Double Ratchet exclusively (per-message forward secrecy).
   * Throws EncryptionError if all paths fail.
   * 
   * CRITICAL: Every payload now carries `encryptionMode` for deterministic decryption routing.
   */
  const encrypt = useCallback(async (plaintext: string, localId?: string): Promise<string> => {
    if (localId) {
      const cachedPayload = pendingPayloadRef.current.get(localId);
      if (cachedPayload) {
        console.info(`[E2EE] Reusing cached encrypted payload for retry (${localId})`);
        return cachedPayload;
      }
    }

    // BLOCK if fingerprint changed and not yet acknowledged (Signal-style strict mode)
    // Per Signal protocol: a fingerprint change MUST be explicitly acknowledged before
    // any new messages can be encrypted. This prevents MITM downgrade attacks where
    // an attacker replaces the peer's key and the sender unknowingly encrypts to the attacker.
    if (state.fingerprintChanged) {
      throw new EncryptionError('🔒 Clé de sécurité du contact modifiée — vérifiez l\'identité avant d\'envoyer');
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
      throw new EncryptionError('🔒 Clés du contact indisponibles — message en attente chiffrée jusqu\'à publication du bundle');
    }

    if (!cryptoRateCheck('encrypt')) {
      throw new EncryptionError('Rate limited — possible exfiltration attempt');
    }

    // Signal protocol: NEVER fall back from Double Ratchet to legacy.
    // A fallback would be a downgrade attack vector — an attacker who causes
    // ratchet init to fail (e.g. by deleting prekeys) would force weaker encryption.
    // Instead, we throw and let the message queue retry when ratchet is ready.
    const ratchet = await initRatchetIfNeeded();
    const readiness = getRatchetReadiness(ratchet);
    if (!ratchet || !readiness.canEncrypt || !isRatchetReadyForEncrypt(ratchet)) {
      throw new EncryptionError('🔒 Session Double Ratchet non prête — message en attente, réessai automatique');
    }

    const { envelope, newState } = await ratchetEncrypt(
      ratchet,
      plaintext,
      keysRef.current.signingPrivateKey,
      keysRef.current.fingerprint,
    );

    const taggedEnvelope = envelope as any;
    taggedEnvelope.encryptionMode = 'ratchet';

    if (x3dhInfoRef.current && !peerHasRespondedRef.current) {
      taggedEnvelope.x3dh = x3dhInfoRef.current;
      console.info('[E2EE] ✅ encrypt with PreKey header (awaiting peer response)');
    } else {
      console.info('[E2EE] ✅ encrypt via Double Ratchet');
    }

    const serializedPayload = hardGlobals.jsonStringify(taggedEnvelope);
    if (localId) {
      pendingPayloadRef.current.set(localId, serializedPayload);
    }

    ratchetRef.current = newState;
    await saveRatchetLocal(conversationId!, newState, x3dhInfoRef.current);

    setState(s => ({ ...s, ratchetActive: true }));
    return serializedPayload;
  }, [state.fingerprintChanged, conversationId, user, initRatchetIfNeeded]);

  /**
   * Decrypt — NEVER shows raw ciphertext.
   * Uses `encryptionMode` tag for deterministic dispatch.
   * For legacy messages without the tag, falls back to heuristic detection.
   */
  const decrypt = useCallback(async (body: string): Promise<{ text: string; encrypted: boolean; verified: boolean }> => {
    if (!isEncryptedMessage(body) && !isRatchetEnvelope(body)) {
      return { text: body, encrypted: false, verified: false };
    }

    if (!isZeus && !peerKeyRef.current) {
      // Only sync if we don't have peer keys yet — prevents request storm
      // when decrypting many messages concurrently
      const syncKey = `${user?.id}:${peerUserId}`;
      if (!_peerSyncPromise.has(syncKey)) {
        const p = ensureKeysAndPeerSync(false).finally(() => _peerSyncPromise.delete(syncKey));
        _peerSyncPromise.set(syncKey, p);
      }
      await _peerSyncPromise.get(syncKey);
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
        return await decryptRatchetMessage(parsed, body);
      }

      // Legacy envelope (has ct but no hdr)
      return await decryptLegacyMessage(parsed, body);

    } catch (err) {
      console.error('[E2EE] decrypt failed:', err);
      return { text: '🔒 Message chiffré', encrypted: true, verified: false };
    }
  }, [conversationId, ensureKeysAndPeerSync, isZeus, user]);

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
          ratchet = persisted.state;
          ratchetRef.current = ratchet;
          console.info('[RATCHET] Loaded persisted ratchet state for decrypt');
        } else if (x3dhHeader) {
          // X3DH responder: derive shared secret from the X3DH header
          console.info(`[X3DH] init responder — SPK #${x3dhHeader.spkId}, OPK ${x3dhHeader.opkId ?? 'none'}`);
          const { sharedSecret, spkKeyPair } = await x3dhRespond(
            keysRef.current,
            user.id,
            x3dhHeader,
          );
          // Per Signal spec: Bob uses his SPK key pair as initial ratchet DH pair
          // dhReceivingKey starts as null — it will be set from Alice's ratchet header below
          ratchet = await initRatchetAsResponder(
            conversationId, sharedSecret, spkKeyPair,
          );
          ratchetRef.current = ratchet;
          console.info('[RATCHET] ✅ init with SPK (responder) — dhReceivingKey=null, will be set from header');
        } else {
          // ⛔ No X3DH header on first ratchet message and no persisted state
          // This is a protocol error — do NOT fallback with random keys
          console.error('[E2EE] ⛔ X3DH header MISSING on first ratchet message — cannot init responder ratchet. This message cannot be decrypted without proper X3DH handshake.');
          return { text: '🔒 Message illisible (en-tête X3DH manquant)', encrypted: true, verified: false };
        }
      } catch (initErr) {
        const errMsg = initErr instanceof Error ? initErr.message : String(initErr);
        console.error('[E2EE] ⛔ Ratchet responder init FAILED:', errMsg);
        // Distinguish specific errors
        if (errMsg.includes('SPK') && errMsg.includes('NOT FOUND')) {
          return { text: '🔒 Message illisible (clé signée introuvable)', encrypted: true, verified: false };
        }
        if (errMsg.includes('OPK') && errMsg.includes('NOT FOUND')) {
          return { text: '🔒 Message illisible (OPK introuvable / handshake incohérent)', encrypted: true, verified: false };
        }
        return { text: '🔒 Message illisible (erreur d\'initialisation)', encrypted: true, verified: false };
      }
    }

    if (ratchet) {
      const readiness = getRatchetReadiness(ratchet);
      if (!readiness.canDecrypt) {
        console.warn('[E2EE] Ratchet state not decrypt-ready:', readiness.reason);
        return { text: '🔒 Message illisible (session expirée)', encrypted: true, verified: false };
      }

      try {
        console.debug(`[RATCHET] decrypt — msg #${envelope.hdr.n}, dh=${envelope.hdr.dh.slice(0, 12)}…`);
        const { plaintext, verified, newState } = await ratchetDecrypt(
          ratchet, envelope, peerKeyRef.current?.signingKey,
        );
        ratchetRef.current = newState;
        if (!peerHasRespondedRef.current) {
          peerHasRespondedRef.current = true;
          if (x3dhInfoRef.current) {
            console.info('[E2EE] Peer responded — X3DH header cleared (Signal-style promotion)');
            x3dhInfoRef.current = null;
          }
        }
        // Persist ratchet with X3DH header cleared (null if peer responded)
        await saveRatchetLocal(conversationId!, newState, x3dhInfoRef.current);
        setState(s => ({ ...s, ratchetActive: true }));
        console.debug(`[RATCHET] ✅ decrypt OK — verified=${verified}`);
        return { text: plaintext, encrypted: true, verified };
      } catch (ratchetErr) {
        const errMsg = ratchetErr instanceof Error ? ratchetErr.message : String(ratchetErr);
        console.error('[E2EE] ❌ Ratchet decrypt failed:', errMsg);
        // Do NOT fallback to legacy — this is a ratchet-tagged message
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
        console.error(`[X3DH] OPK mismatch — resync needed (prekey #${parsed.prekey.id} introuvable localement)`);
        generateAndUploadPrekeys(user.id).catch(err => {
          console.error('[X3DH] Failed to re-upload prekeys after OPK mismatch:', err);
        });
        return { text: '🔒 Message illisible (prekey introuvable / état incohérent)', encrypted: true, verified: false };
      } catch (prekeyErr) {
        console.error('[E2EE] Prekey decrypt failed:', prekeyErr);
        return { text: '🔒 Message illisible (échec prekey / état incohérent)', encrypted: true, verified: false };
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
      // First decrypt failed — session may be desynchronized.
      // Auto-correct local/remote key state, rebuild the session, and retry once.
      if (user && conversationId && peerUserId) {
        try {
          console.warn('[E2EE] Legacy decrypt failed — attempting session re-derivation');
          const repaired = await ensureKeysAndPeerSync(true);

          if (repaired && peerKeyRef.current) {
            const newSession = await loadSessionKey(conversationId);
            if (!newSession) {
              return { text: '🔒 Clé de session manquante', encrypted: true, verified: false };
            }

            const retryResult = await decryptMessage(rawBody, newSession.sharedSecret, peerKeyRef.current.signingKey);
            console.info('[E2EE] ✅ Decrypt succeeded after session re-derivation');
            return { text: retryResult.plaintext, encrypted: true, verified: retryResult.verified };
          }
        } catch (retryErr) {
          console.error('[E2EE] Session re-derivation decrypt also failed:', retryErr);
        }
      }
      return { text: '🔒 Message chiffré (clé expirée)', encrypted: true, verified: false };
    }
  }, [conversationId, user, ensureKeysAndPeerSync, ensureLegacySession, peerUserId]);

  /** Check if encryption is ready for this conversation */
  const isReady = useCallback((): boolean => {
    if (isZeus) return true;
    // Ready if we have peer keys and our own keys, and no fingerprint block
    return state.encrypted && !!keysRef.current && !!peerKeyRef.current && !state.fingerprintChanged;
  }, [state.encrypted, state.fingerprintChanged, isZeus]);

  /** Acknowledge fingerprint change — user explicitly trusts new key */
  const acknowledgeFingerprint = useCallback(async () => {
    if (peerKeyRef.current && peerUserId) {
      saveKnownFingerprint(peerUserId, peerKeyRef.current.fingerprint);
      saveKnownFingerprintServer(peerUserId, peerKeyRef.current.fingerprint);
    }
    if (conversationId) {
      // Clear old ratchet state
      openRatchetDB().then(db => {
        try {
          const tx = db.transaction(RATCHET_STORE_NAME, 'readwrite');
          tx.objectStore(RATCHET_STORE_NAME).delete(conversationId);
        } catch {}
      }).catch(() => {});
      ratchetRef.current = null;
      peerHasRespondedRef.current = false;
      x3dhInfoRef.current = null;
      pendingPayloadRef.current.clear();

      // Delete old legacy session and re-establish with new peer key
      try {
        const { deleteSessionKey } = await import('@/lib/crypto/keyManager');
        await deleteSessionKey(conversationId);
      } catch {}

      if (keysRef.current && peerKeyRef.current) {
        try {
          await establishSession(keysRef.current, peerKeyRef.current.identityKey, conversationId, peerKeyRef.current.fingerprint);
          legacySessionReadyRef.current = true;
          console.log('[E2EE] ✅ Legacy session re-established after fingerprint acknowledgement');
        } catch (e) {
          console.warn('[E2EE] Legacy session re-establish failed after ack:', e);
          legacySessionReadyRef.current = false;
        }
      }
    }
    setState(s => ({ ...s, fingerprintChanged: false, ready: true, ratchetActive: false, initError: null }));
  }, [peerUserId, conversationId]);

  const acknowledgeSentPayload = useCallback(async (localId: string) => {
    pendingPayloadRef.current.delete(localId);
    console.info(`[E2EE] ✅ Payload acknowledged (${localId})`);
  }, [conversationId]);

  return {
    ...state,
    encrypt,
    decrypt,
    isReady,
    acknowledgeFingerprint,
    acknowledgeSentPayload,
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
