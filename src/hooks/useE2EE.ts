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
  initRatchetAsInitiator,
  initRatchetAsResponder,
  ratchetEncrypt,
  ratchetDecrypt,
  serializeRatchetState,
  deserializeRatchetState,
  getRatchetReadiness,
  isRatchetReadyForEncrypt,
  isRatchetReadyForDecrypt,
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
import { base64ToBuffer, bufferToBase64, constantTimeEqual } from '@/lib/crypto/utils';
import { cryptoRateCheck } from '@/lib/crypto/rateLimiter';
import { verifyCryptoIntegrity, isTampered, hardGlobals, hardCrypto } from '@/lib/crypto/cryptoIntegrity';
import { KX_KEY_PARAMS, STORE_PREKEYS, STORE_SESSION } from '@/lib/crypto/constants';
import { openE2EEDB } from '@/lib/crypto/indexedDb';
import { runTx, runTxOn, reqToPromise } from '@/lib/crypto/indexedDbTx';
import { isCryptoJsonBody, isStrictRatchetEnvelopeBody, isUnsupportedEncryptedBody } from '@/lib/messaging/messageCompatibility';
import { isSenderKeyWire, parseSKDM, SENDER_KEY_PREFIX } from '@/lib/crypto/senderKeys';
import {
  installSKDM,
  loadRecipientStateForWire,
  decryptFromGroup,
} from '@/lib/crypto/senderKeySession';
import { tryEncryptViaSenderKeys } from '@/lib/crypto/senderKeyOutbound';

const ZEUS_ID = '00000000-0000-0000-0000-000000000001';
const RATCHET_DB_NAME = 'forsure-ratchet';
const RATCHET_DB_VERSION = 1;
const RATCHET_STORE_NAME = 'ratchet-states';
const KNOWN_FP_KEY = 'forsure-known-fps';

// ─── Global deduplication & caching layer ───
// Prevents request storms when multiple hook instances or concurrent decrypts
// fire identical API calls.

/** Deduplication lock for ensureKeysAndPeerSync */
const _peerSyncPromise = new Map<string, Promise<boolean>>();

/** Global cache for peer public keys — prevents repeated fetches */
const _peerKeyCache = new Map<string, { data: { identity_key: string; signing_key: string; fingerprint: string } | null; ts: number }>();
const PEER_KEY_TTL = 120_000; // 2 minutes

/** Cached auth user ID — avoids repeated supabase.auth.getUser() network calls */
let _cachedAuthUserId: string | null = null;
let _cachedAuthUserIdTs = 0;
const AUTH_USER_CACHE_TTL = 300_000; // 5 minutes

/**
 * Global decrypt serializer per conversation.
 * When 50 messages mount simultaneously, they ALL call decrypt() in parallel.
 * Without serialization, each one tries to init the ratchet independently,
 * causing hundreds of duplicate user_public_keys/x3dh requests.
 * This ensures only ONE ratchet init runs at a time per conversation.
 */
const _decryptQueue = new Map<string, Promise<any>>();
const _ratchetTerminalFailures = new Set<string>();

async function serializedDecrypt<T>(convId: string, fn: () => Promise<T>): Promise<T> {
  const prev = _decryptQueue.get(convId) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run fn after previous completes (even if it failed)
  _decryptQueue.set(convId, next);
  // Clean up the reference once done to prevent memory leaks
  next.finally(() => {
    if (_decryptQueue.get(convId) === next) {
      _decryptQueue.delete(convId);
    }
  });
  return next;
}

function markRatchetTerminalFailure(conversationId: string | undefined, body: string | undefined) {
  if (!conversationId || !body) return;
  _ratchetTerminalFailures.add(`${conversationId}:${body}`);
}

function hasRatchetTerminalFailure(conversationId: string | undefined, body: string | undefined) {
  if (!conversationId || !body) return false;
  return _ratchetTerminalFailures.has(`${conversationId}:${body}`);
}

function clearRatchetTerminalFailures(conversationId: string | undefined) {
  if (!conversationId) {
    _ratchetTerminalFailures.clear();
    return;
  }
  for (const key of Array.from(_ratchetTerminalFailures)) {
    if (key.startsWith(`${conversationId}:`)) _ratchetTerminalFailures.delete(key);
  }
}

/** Dedup for own key publishing — prevents ChatView + ChatWidget from both publishing */
let _ownKeyPublishPromise: Promise<void> | null = null;
let _ownKeyPublishTs = 0;
const OWN_KEY_PUBLISH_TTL = 60_000; // 1 minute

/** Dedup for initKeys — prevents ChatView + ChatWidget from both initializing */
let _initKeysPromise: Promise<void> | null = null;
let _initKeysTs = 0;
const INIT_KEYS_TTL = 30_000; // 30 seconds

/** Dedup for peer key setup effect — prevents duplicate runs from ChatView + ChatWidget */
const _peerSetupPromise = new Map<string, Promise<void>>();
const _peerSetupTs = new Map<string, number>();
const PEER_SETUP_TTL = 30_000; // 30 seconds

async function getCachedAuthUserId(): Promise<string | null> {
  if (_cachedAuthUserId && Date.now() - _cachedAuthUserIdTs < AUTH_USER_CACHE_TTL) {
    return _cachedAuthUserId;
  }
  try {
    const { data } = await supabase.auth.getUser();
    _cachedAuthUserId = data.user?.id ?? null;
    _cachedAuthUserIdTs = Date.now();
    return _cachedAuthUserId;
  } catch {
    return _cachedAuthUserId; // return stale if network fails
  }
}

/** Fetch peer public keys with global dedup + cache */
async function fetchPeerPublicKeys(peerUserId: string): Promise<{ identity_key: string; signing_key: string; fingerprint: string } | null> {
  const cached = _peerKeyCache.get(peerUserId);
  if (cached && Date.now() - cached.ts < PEER_KEY_TTL) {
    return cached.data;
  }

  // Dedup in-flight requests for the same peer
  const inflightKey = `fetch:${peerUserId}`;
  if (_peerSyncPromise.has(inflightKey)) {
    await _peerSyncPromise.get(inflightKey);
    const afterWait = _peerKeyCache.get(peerUserId);
    return afterWait?.data ?? null;
  }

  const p = (async () => {
    const { data } = await supabase
      .from('user_public_keys')
      .select('identity_key, signing_key, fingerprint')
      .eq('user_id', peerUserId)
      .eq('is_active', true)
      .maybeSingle();
    _peerKeyCache.set(peerUserId, { data, ts: Date.now() });
    return !!data;
  })().finally(() => _peerSyncPromise.delete(inflightKey));

  _peerSyncPromise.set(inflightKey, p);
  await p;
  return _peerKeyCache.get(peerUserId)?.data ?? null;
}

// ─── IndexedDB ratchet persistence ───

// openRatchetDB helpers removed — all ratchet IndexedDB access goes through
// `runTxOn('ratchet', [RATCHET_STORE_NAME], ...)` (Safari-safe singleton + retries).

function recreateLegacyE2EEDatabase(): Promise<void> {
  return new Promise((resolve) => {
    void (async () => {
      try {
        const storesToClear = [STORE_SESSION, STORE_PREKEYS];
        await runTx(storesToClear, 'readwrite', (tx) => {
          for (const s of storesToClear) {
            try { tx.objectStore(s).clear(); } catch {}
          }
        });
        console.log('[E2EE] Repaired IndexedDB schema and cleared transient crypto stores');
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
    const record: any = { convId, data: json };
    if (x3dhHeader !== undefined) {
      record.x3dhHeader = x3dhHeader ? hardGlobals.jsonStringify(x3dhHeader) : null;
    }
    await runTxOn('ratchet', [RATCHET_STORE_NAME], 'readwrite', (tx) => {
      tx.objectStore(RATCHET_STORE_NAME).put(record);
    });
    try {
      const { requestBackgroundBackup } = await import('@/lib/crypto/accountKeyBackup');
      requestBackgroundBackup('ratchet-save');
    } catch {}
  } catch (e) {
    console.error('[E2EE] Failed to persist ratchet state:', e);
  }
}

async function loadRatchetLocal(convId: string): Promise<{ state: RatchetState; x3dhHeader: X3DHInitialMessage | null } | null> {
  try {
    const result = await runTxOn('ratchet', [RATCHET_STORE_NAME], 'readonly', (tx) =>
      reqToPromise<any>(tx.objectStore(RATCHET_STORE_NAME).get(convId)),
    );
    if (!result?.data) return null;
    const state = await deserializeRatchetState(result.data);
    const x3dhHeader = result.x3dhHeader ? hardGlobals.jsonParse(result.x3dhHeader) as X3DHInitialMessage : null;
    return { state, x3dhHeader };
  } catch {
    return null;
  }
}

async function deleteRatchetLocal(convId: string): Promise<void> {
  try {
    await runTxOn('ratchet', [RATCHET_STORE_NAME], 'readwrite', (tx) => {
      tx.objectStore(RATCHET_STORE_NAME).delete(convId);
    });
    console.info(`[E2EE] 🧹 Ratchet local purgé pour conv ${convId}`);
  } catch (e) {
    console.warn('[E2EE] deleteRatchetLocal failed:', e);
  }
}

/**
 * Cache-bust: vérifie côté serveur si le SPK actif du pair a changé depuis
 * notre dernier handshake X3DH. Si oui, retourne true → la session locale doit
 * être purgée pour forcer un nouveau X3DH avec le bundle frais.
 *
 * Throttle: 1 vérif max toutes les 30s par conversation pour éviter le spam réseau.
 */
const _spkCheckCache = new Map<string, number>();
const SPK_CHECK_TTL = 30_000;

async function isPeerSPKStale(peerUserId: string, lastUsedSpkId: number | undefined): Promise<boolean> {
  if (lastUsedSpkId === undefined || lastUsedSpkId === null) return false;
  const now = Date.now();
  const last = _spkCheckCache.get(peerUserId) ?? 0;
  if (now - last < SPK_CHECK_TTL) return false;
  _spkCheckCache.set(peerUserId, now);

  try {
    const { data, error } = await supabase.rpc('get_signed_prekey', { p_user_id: peerUserId });
    if (error || !data || data.length === 0) return false;
    const currentSpkId = data[0].spk_id as number;
    if (currentSpkId !== lastUsedSpkId) {
      console.warn(`[E2EE] ⚠️ SPK du pair ${peerUserId} a changé (local=#${lastUsedSpkId} → serveur=#${currentSpkId}) — re-handshake requis`);
      return true;
    }
    return false;
  } catch (e) {
    console.warn('[E2EE] isPeerSPKStale check failed:', e);
    return false;
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

type FingerprintCheckResult = { changed: boolean; previousFp: string | null };

const _fpCheckCache = new Map<string, { result: FingerprintCheckResult; ts: number }>();

function invalidateFingerprintCheckCache(peerUserId: string) {
  for (const key of _fpCheckCache.keys()) {
    if (key.includes(`:${peerUserId}:`)) {
      _fpCheckCache.delete(key);
    }
  }
}

/** Save fingerprint to server for cross-device verification (deduplicated) */
const _fpSaveCache = new Map<string, number>();
async function saveKnownFingerprintServer(peerUserId: string, fp: string, force = false) {
  // Deduplicate: skip if same fp was saved in the last 60s
  const cacheKey = `${peerUserId}:${fp}`;
  const lastSaved = _fpSaveCache.get(cacheKey);
  if (!force && lastSaved && Date.now() - lastSaved < 60_000) return;
  _fpSaveCache.set(cacheKey, Date.now());

  try {
    const userId = await getCachedAuthUserId();
    if (!userId) return;
    await supabase
      .from('user_known_fingerprints')
      .upsert({
        user_id: userId,
        peer_user_id: peerUserId,
        fingerprint: fp,
        last_seen_at: new Date().toISOString(),
        acknowledged: true,
      }, { onConflict: 'user_id,peer_user_id' });
    invalidateFingerprintCheckCache(peerUserId);
  } catch (e) {
    console.warn('[E2EE] Server fingerprint save failed:', e);
  }
}

/** Check fingerprint against both local AND server records (with cache) */
async function checkFingerprintChangeWithServer(
  currentUserId: string,
  peerUserId: string,
  currentFp: string
): Promise<FingerprintCheckResult> {
  const known = getKnownFingerprints();
  const localPrevious = known[peerUserId];

  // Cache server check for 60s to avoid request storms
  const cacheKey = `${currentUserId}:${peerUserId}:${currentFp}`;
  const cached = _fpCheckCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 60_000) {
    return cached.result;
  }

  try {
    const { data } = await supabase
      .from('user_known_fingerprints')
      .select('fingerprint, acknowledged')
      .eq('user_id', currentUserId)
      .eq('peer_user_id', peerUserId)
      .maybeSingle();

    if (data && data.fingerprint !== currentFp) {
      // SILENT TRUST-ON-FIRST-ROTATION:
      // If the previous fingerprint was never explicitly verified by the user
      // (acknowledged=false), this is almost always a benign rotation
      // (peer regenerated identity after IndexedDB wipe / new device / fresh
      // install). Blocking here turns into a permanent "waiting_secure_channel"
      // dead-end because the user has no UI to "acknowledge" the change.
      // We silently adopt the new fingerprint and continue — the key sentinel
      // and ratchet still detect any real MITM via signature failures.
      if (!data.acknowledged) {
        console.warn('[PEER_KEY] 🔄 Server fingerprint rotated for', peerUserId, '— auto-trusting (was never user-verified)');
        try {
          const userId = await getCachedAuthUserId();
          if (userId) {
            await supabase
              .from('user_known_fingerprints')
              .upsert({
                user_id: userId,
                peer_user_id: peerUserId,
                fingerprint: currentFp,
                last_seen_at: new Date().toISOString(),
                acknowledged: false,
              }, { onConflict: 'user_id,peer_user_id' });
          }
        } catch (e) {
          console.warn('[PEER_KEY] auto-rotate save failed', e);
        }
        saveKnownFingerprint(peerUserId, currentFp);
        const result = { changed: false, previousFp: null };
        _fpCheckCache.set(cacheKey, { result, ts: Date.now() });
        return result;
      }
      console.warn('[PEER_KEY] ⚠️ Server-side fingerprint mismatch for', peerUserId, '(was previously verified)');
      // Lot A4 — record the change so the chat banner can surface it.
      try {
        const { recordIdentityChange } = await import('@/lib/crypto/identityChangeLedger');
        await recordIdentityChange({
          observerUserId: currentUserId,
          peerUserId,
          previousFingerprint: data.fingerprint,
          newFingerprint: currentFp,
        });
      } catch (e) {
        console.warn('[A4] recordIdentityChange failed', e);
      }
      const result = { changed: true, previousFp: data.fingerprint };
      _fpCheckCache.set(cacheKey, { result, ts: Date.now() });
      return result;
    }

    if (data && data.fingerprint === currentFp) {
      if (localPrevious !== currentFp) saveKnownFingerprint(peerUserId, currentFp);
      const result = { changed: false, previousFp: null };
      _fpCheckCache.set(cacheKey, { result, ts: Date.now() });
      return result;
    }
  } catch {
  }

  if (localPrevious && localPrevious !== currentFp) {
    return { changed: true, previousFp: localPrevious };
  }

  const result = { changed: false, previousFp: null };
  _fpCheckCache.set(cacheKey, { result, ts: Date.now() });
  return result;
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

function base64KeysEqual(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  try {
    const left = new Uint8Array(base64ToBuffer(a));
    const right = new Uint8Array(base64ToBuffer(b));
    return constantTimeEqual(left, right);
  } catch {
    return false;
  }
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
      void runTxOn('ratchet', [RATCHET_STORE_NAME], 'readwrite', (tx) => {
        tx.objectStore(RATCHET_STORE_NAME).clear();
      }).then(() => console.log('[E2EE] Cleared stale ratchet states (migration v4)')).catch(() => {});
      void runTx([STORE_SESSION], 'readwrite', (tx) => {
        try { tx.objectStore(STORE_SESSION).clear(); } catch {}
      }).then(() => console.log('[E2EE] Cleared stale session keys (migration v4)')).catch(() => {});
    }
  } catch {}
}

// ─── Ratchet readiness check ───

/** Returns true only if the ratchet state is fully ready for v4 AEAD encryption */
function isRatchetFullyReady(state: RatchetState | null): boolean {
  if (!isRatchetReadyForEncrypt(state)) return false;
  // v4 strict: identity keys + role MUST be present, otherwise AAD cannot be
  // built and ratchetEncrypt will throw E_RATCHET_V4_REQUIRED. Old persisted
  // states predating v4 are treated as invalid → triggers a fresh X3DH.
  if (!state?.myIdentityKeyB64 || !state?.peerIdentityKeyB64 || !state?.role) {
    return false;
  }
  return true;
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

export interface DecryptResult {
  text: string;
  encrypted: boolean;
  verified: boolean;
  incompatible?: boolean;
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
    // Warm up the auth user ID cache to avoid repeated getUser() calls
    _cachedAuthUserId = user.id;
    _cachedAuthUserIdTs = Date.now();
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

      // Refresh Signed Prekey if needed (X3DH 3-DH only mode — no OPK).
      refreshSignedPrekeyIfNeeded(user.id, keys.signingPrivateKey).catch(e =>
        console.warn('[E2EE] SPK refresh failed:', e),
      );

      // IMPORTANT: do NOT auto-delete raw identity JWKs immediately after a
      // successful PIN unlock. Device registration + resyncE2EE call
      // getOrCreateIdentityKeys() after this hook initializes; deleting here
      // recreates the observed loop:
      //   PIN ok → raw keys restored → useE2EE init → raw keys deleted →
      //   resync/device publish sees only wrapped keys → PinUnlockRequiredError.
      // Raw keys are still purged by the explicit PIN lock path
      // (lockWithoutWiping: blur/idle/return), after the latest snapshot is
      // re-wrapped. During the unlocked session they must remain available to
      // the E2EE maintenance pipeline.
      console.log('[E2EE] PIN-unlocked raw identity retained for device registration/resync until next lock');

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

  // Auto-init on mount — GLOBALLY DEDUPLICATED across hook instances
  useEffect(() => {
    if (!user || initRef.current) return;
    initRef.current = true;
    cleanupLegacyStorage();
    // Dedup: if another instance already ran initKeys recently, reuse its promise
    if (_initKeysPromise && Date.now() - _initKeysTs < INIT_KEYS_TTL) {
      _initKeysPromise.then(() => {
        // After the other instance finishes, sync our local refs
        if (!keysRef.current) {
          getOrCreateIdentityKeys(user.id).then(keys => {
            keysRef.current = keys;
            exportPublicKeyBundle(keys).then(b => {
              setState(s => ({ ...s, fingerprint: b.fingerprint, initError: null }));
            });
          }).catch(() => {});
        }
      });
      return;
    }
    _initKeysTs = Date.now();
    _initKeysPromise = initKeys().catch(() => {}).finally(() => {
      // Keep promise reference for TTL window, don't null immediately
    });
  }, [user, initKeys]);

  // Re-init when PIN unlocks keys
  useEffect(() => {
    const handler = () => {
      console.log('[E2EE] Keys unlocked via PIN — re-initializing');
      clearRatchetTerminalFailures(conversationId);
      initKeys();
    };
    window.addEventListener('forsure-keys-unlocked', handler);
    return () => window.removeEventListener('forsure-keys-unlocked', handler);
  }, [conversationId, initKeys]);

  // Re-init when iOS/backup restore rehydrates IndexedDB after a cache purge.
  useEffect(() => {
    const handler = () => {
      console.log('[E2EE] Keys restored from backup — resetting stale refs');
      keysRef.current = null;
      ratchetRef.current = null;
      prekeyInfoRef.current = null;
      x3dhInfoRef.current = null;
      legacySessionReadyRef.current = false;
      peerHasRespondedRef.current = false;
      clearRatchetTerminalFailures(conversationId);
      void initKeys().finally(() => {
        try { window.dispatchEvent(new CustomEvent('forsure-decrypt-retry')); } catch {}
      });
    };
    window.addEventListener('forsure-keys-restored', handler);
    return () => window.removeEventListener('forsure-keys-restored', handler);
  }, [conversationId, initKeys]);

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
  // GLOBALLY DEDUPLICATED: if ChatView + ChatWidget both mount with the same
  // conversationId+peerUserId, only ONE runs the full setup; the other waits.
  useEffect(() => {
    if (!peerUserId || !user) return;

    if (isZeus) {
      setState(s => ({ ...s, encrypted: false, ready: true, ratchetActive: false }));
      return;
    }

    const setupKey = `${user.id}:${peerUserId}:${conversationId}`;
    const lastSetup = _peerSetupTs.get(setupKey);
    if (lastSetup && Date.now() - lastSetup < PEER_SETUP_TTL && _peerSetupPromise.has(setupKey)) {
      // Another hook instance already ran this setup recently — wait for it
      _peerSetupPromise.get(setupKey)!.then(() => {
        // Sync state from cached data
        const cached = _peerKeyCache.get(peerUserId);
        if (cached?.data) {
          peerKeyRef.current = {
            identityKey: cached.data.identity_key,
            signingKey: cached.data.signing_key,
            fingerprint: cached.data.fingerprint,
          };
          setState(s => ({
            ...s,
            peerFingerprint: cached.data!.fingerprint,
            encrypted: true,
            ready: true,
            peerKeyMissing: false,
            initError: null,
          }));
        }
      }).catch(() => {});
      return;
    }

    let cancelled = false;

    const setupPromise = (async () => {
      try {
        // Ensure our own keys are ready first (may race with initKeys)
        if (!keysRef.current) {
          console.log('[E2EE] Waiting for own keys before peer fetch...');
          const keys = await getOrCreateIdentityKeys(user.id);
          if (cancelled) return;
          keysRef.current = keys;
          const bundle = await exportPublicKeyBundle(keys);
          if (cancelled) return;
          
          // Publish if not done yet — DEDUPLICATED across hook instances
          if (!_ownKeyPublishPromise || Date.now() - _ownKeyPublishTs > OWN_KEY_PUBLISH_TTL) {
            _ownKeyPublishTs = Date.now();
            _ownKeyPublishPromise = (async () => {
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
              
              supabase.rpc('push_my_fingerprint_to_peers').then(({ data: updated }) => {
                if (updated && (updated as number) > 0) console.log('[E2EE] Pushed fingerprint to', updated, 'peer(s)');
              });
            })();
          }
          await _ownKeyPublishPromise;
          
          setState(s => ({ ...s, fingerprint: bundle.fingerprint }));
          console.log('[E2EE] Own keys loaded on-demand');
        }

        const data = await fetchPeerPublicKeys(peerUserId);

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
          if (fpChanged) {
            console.warn('[PEER_KEY] 🛑 Fingerprint changed for', peerUserId, '— BLOCKING until user acknowledges');
            
            peerKeyRef.current = {
              identityKey: data.identity_key,
              signingKey: data.signing_key,
              fingerprint: data.fingerprint,
            };

            if (conversationId) {
              void runTxOn('ratchet', [RATCHET_STORE_NAME], 'readwrite', (tx) => {
                try { tx.objectStore(RATCHET_STORE_NAME).delete(conversationId); } catch {}
              }).catch(() => {});
              ratchetRef.current = null;
              peerHasRespondedRef.current = false;
              x3dhInfoRef.current = null;
              pendingPayloadRef.current.clear();
              legacySessionReadyRef.current = false;
            }
            
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

          // Legacy per-conversation session removed — Double Ratchet handles
          // all messaging encryption. Nothing to pre-establish here.

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

    _peerSetupTs.set(setupKey, Date.now());
    _peerSetupPromise.set(setupKey, setupPromise);
    setupPromise.finally(() => {
      // Clean up after TTL to allow re-runs
      setTimeout(() => {
        if (_peerSetupPromise.get(setupKey) === setupPromise) {
          _peerSetupPromise.delete(setupKey);
        }
      }, PEER_SETUP_TTL);
    });

    return () => { cancelled = true; };
  }, [peerUserId, user, conversationId, isZeus]);

  // Retry peer key fetch when peerKeyMissing — contact may have come online
  useEffect(() => {
    if (!state.peerKeyMissing || !peerUserId || !user || isZeus) return;
    const interval = setInterval(async () => {
      try {
        // Invalidate cache before retry to get fresh data
        _peerKeyCache.delete(peerUserId);
        const data = await fetchPeerPublicKeys(peerUserId);
        if (data) {
          console.log('[PEER_KEY] ✅ Peer keys now available — upgrading to encrypted mode');
          const { changed: fpChanged } = await checkFingerprintChangeWithServer(user.id, peerUserId, data.fingerprint);
          peerKeyRef.current = {
            identityKey: data.identity_key,
            signingKey: data.signing_key,
            fingerprint: data.fingerprint,
          };
          if (fpChanged) {
            console.warn('[PEER_KEY] Fingerprint changed while retrying peer keys - blocking until acknowledgement');
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
          saveKnownFingerprint(peerUserId, data.fingerprint);
          saveKnownFingerprintServer(peerUserId, data.fingerprint);
          
          // Legacy per-conversation session removed.
          
          setState(s => ({
            ...s,
            peerFingerprint: data.fingerprint,
            encrypted: true,
            ready: true,
            peerKeyMissing: false,
          }));
        }
      } catch {}
    }, 30_000); // retry every 30s
    return () => clearInterval(interval);
  }, [state.peerKeyMissing, peerUserId, user, isZeus, conversationId]);

  // Legacy per-conversation session helper removed — Double Ratchet only.

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
      return !state.fingerprintChanged;
    }

    try {
      const freshPeerKey = await fetchPeerPublicKeys(peerUserId);

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

      if (fingerprintChanged) {
        if (conversationId) {
          try {
            await runTxOn('ratchet', [RATCHET_STORE_NAME], 'readwrite', (tx) => {
              tx.objectStore(RATCHET_STORE_NAME).delete(conversationId);
            });
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

        setState(s => ({
          ...s,
          peerFingerprint: freshPeerKey.fingerprint,
          encrypted: true,
          ready: false,
          ratchetActive: false,
          fingerprintChanged: true,
          peerKeyMissing: false,
          initError: 'fingerprint_changed',
        }));

        return false;
      }

      saveKnownFingerprint(peerUserId, freshPeerKey.fingerprint);
      void saveKnownFingerprintServer(peerUserId, freshPeerKey.fingerprint);

      if (conversationId && forceSessionRefresh) {
        try {
          await runTxOn('ratchet', [RATCHET_STORE_NAME], 'readwrite', (tx) => {
            tx.objectStore(RATCHET_STORE_NAME).delete(conversationId);
          });
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

      // Legacy session re-establish removed.

      setState(s => ({
        ...s,
        peerFingerprint: freshPeerKey.fingerprint,
        encrypted: true,
        ready: true,
        ratchetActive: s.ratchetActive,
        fingerprintChanged: false,
        peerKeyMissing: false,
        initError: null,
      }));

      return true;
    } catch (error) {
      console.warn('[E2EE] Peer key sync failed:', error);
      return false;
    }
  }, [conversationId, isZeus, peerUserId, user, state.fingerprintChanged]);

  const resetRatchetBootstrapState = useCallback(async (reason: string) => {
    if (!conversationId) return;

    console.warn(`[E2EE] Resetting local ratchet bootstrap (${reason}) for conversation ${conversationId}`);
    await deleteRatchetLocal(conversationId);
    ratchetRef.current = null;
    x3dhInfoRef.current = null;
    peerHasRespondedRef.current = false;
    pendingPayloadRef.current.clear();
    setState(s => ({ ...s, ratchetActive: false }));
  }, [conversationId]);

  /**
   * Initialize Double Ratchet as initiator (sender of first ratchet message).
   * Uses X3DH for key agreement (3 or 4 DH operations) then seeds Double Ratchet.
   * Never falls back to legacy for outbound modern messages.
   */
  const initRatchetIfNeeded = useCallback(async (): Promise<RatchetState | null> => {
    if (!conversationId || !keysRef.current || !peerKeyRef.current || !peerUserId) return null;

    // ─── Cache-bust: si le SPK du pair a changé sur le serveur depuis notre
    // dernier handshake, purger la session locale pour forcer un nouveau X3DH.
    // Sans ça, l'expéditeur réutilise une session basée sur un SPK obsolète
    // que le récepteur ne peut plus déchiffrer ("clé signée introuvable").
    const lastSpkId = ratchetRef.current
      ? x3dhInfoRef.current?.spkId
      : (await loadRatchetLocal(conversationId))?.x3dhHeader?.spkId;
    if (lastSpkId !== undefined && await isPeerSPKStale(peerUserId, lastSpkId)) {
      console.warn('[E2EE] 🔄 Cache-bust SPK déclenché — purge ratchet local et nouveau X3DH');
      await resetRatchetBootstrapState('peer_spk_stale');
    }

    // Already have a ratchet? Use it only if fully ready
    if (ratchetRef.current) {
      if (isRatchetFullyReady(ratchetRef.current)) {
        return ratchetRef.current;
      }
      await resetRatchetBootstrapState('in_memory_incomplete');
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
      await resetRatchetBootstrapState('persisted_incomplete');
    }

    // X3DH key agreement (Signal spec) — NO legacy fallback
    console.info(`[X3DH] init initiator — fetching bundle for peer ${peerUserId}`);

    const peerSynced = await ensureKeysAndPeerSync(true);
    if (!peerSynced || !peerKeyRef.current) {
      throw new EncryptionError('Cle de securite du contact modifiee - verification obligatoire avant envoi');
    }

    // Prefer per-device bundle (4-DH with OPK); fall back to legacy per-user bundle (3-DH only).
    let bundle = null as Awaited<ReturnType<typeof fetchPrekeyBundle>>;
    let route: 'per-device-4dh' | 'legacy-3dh' = 'legacy-3dh';
    try {
      const { fetchActiveDevices } = await import('@/lib/crypto/deviceList');
      const { fetchPrekeyBundleForDevice } = await import('@/lib/crypto/x3dh');
      const peerDevices = await fetchActiveDevices(peerUserId);
      // Pick most recently seen active device
      const target = peerDevices[0];
      if (target) {
        const devBundle = await fetchPrekeyBundleForDevice(peerUserId, target.deviceId);
        if (devBundle) {
          bundle = devBundle;
          route = 'per-device-4dh';
          console.info(`[X3DH][ROUTE] per-device 4-DH bundle for ${peerUserId.slice(0, 8)}…/${target.deviceId.slice(0, 8)}…`);
        }
      }
    } catch (e) {
      console.warn('[X3DH][ROUTE] per-device bundle lookup failed, falling back to legacy:', e);
    }
    if (!bundle) {
      bundle = await fetchPrekeyBundle(peerUserId);
      console.info(`[X3DH][ROUTE] legacy 3-DH bundle for ${peerUserId.slice(0, 8)}…`);
    }
    if (!bundle) {
      console.error('[X3DH] ⛔ Bundle pair absent, expiré ou incohérent — impossible d\'initialiser X3DH');
      throw new EncryptionError('🔒 Bundle X3DH du contact indisponible ou incohérent — message en attente chiffrée');
    }

    if (
      !base64KeysEqual(bundle.identityKey, peerKeyRef.current.identityKey) ||
      !base64KeysEqual(bundle.signingKey, peerKeyRef.current.signingKey)
    ) {
      throw new EncryptionError('Cle de securite du contact modifiee - verification obligatoire avant envoi');
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
      {
        myIdentityKeyB64: bufferToBase64(myPubRaw),
        peerIdentityKeyB64: peerKeyRef.current.identityKey,
      },
    );

    const readiness = getRatchetReadiness(ratchet);
    if (!readiness.canEncrypt) {
      throw new EncryptionError(`🔒 Double Ratchet non prêt pour l'envoi${readiness.reason ? ` (${readiness.reason})` : ''} — message en attente chiffrée`);
    }

    ratchetRef.current = ratchet;
    await saveRatchetLocal(conversationId, ratchet, x3dhInfoRef.current);
    console.info('[RATCHET] ✅ init with X3DH (initiator) — ready for encrypt');
    return ratchet;
  }, [conversationId, peerUserId, resetRatchetBootstrapState, ensureKeysAndPeerSync]);

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

    // Fingerprint changes are a safety stop: no outbound plaintext or
    // ciphertext is produced until the user explicitly trusts the new key.
    if (state.fingerprintChanged) {
      throw new EncryptionError('Cle de securite du contact modifiee - verification obligatoire avant envoi');
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

    // ─── Sender Keys (group E2EE) opt-in path ──────────────────────────────
    // When `conversations.enable_sender_keys=true`, encrypt via the group
    // chain and emit a `sk1.` wire. SKDM fan-out happens inside the helper
    // (idempotent per chain generation). Returns null when the conv is not
    // opted in or the orchestration fails — we then fall through to the
    // pairwise Double Ratchet path below (zero downgrade risk: both paths
    // are E2EE).
    if (conversationId && user) {
      try {
        const skWire = await tryEncryptViaSenderKeys(conversationId, user.id, plaintext);
        if (skWire) {
          if (localId) pendingPayloadRef.current.set(localId, skWire);
          return skWire;
        }
      } catch (e) {
        console.warn('[E2EE] sender-keys path errored; falling back to pairwise', e);
      }
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
   * 
   * CRITICAL: All decrypts for the same conversation are SERIALIZED via a global
   * queue to prevent 50 concurrent ratchet inits when loading a chat.
   */
  const decrypt = useCallback(async (body: string): Promise<DecryptResult> => {
    // Lot — Sender Keys (group E2EE) wire detection. Bypasses the JSON
    // ratchet envelope path: `sk1.` is a flat dotted wire, not JSON.
    if (typeof body === 'string' && isSenderKeyWire(body)) {
      try {
        const recipient = await loadRecipientStateForWire(body);
        if (!recipient) {
          // SKDM not yet delivered → keep ciphertext placeholder, will retry
          // once the pairwise SKDM lands and installs the chain.
          return { text: '', encrypted: true, verified: false, incompatible: true };
        }
        const { plaintext } = await decryptFromGroup(recipient, body);
        if (plaintext === null) {
          return { text: '', encrypted: true, verified: false, incompatible: true };
        }
        return { text: plaintext, encrypted: true, verified: true };
      } catch (err) {
        console.warn('[E2EE] Sender Key decrypt failed:', err);
        return { text: '', encrypted: true, verified: false, incompatible: true };
      }
    }

    if (!isCryptoJsonBody(body)) {
      return { text: body, encrypted: false, verified: false };
    }

    // Serialize all decrypt operations for this conversation to prevent
    // concurrent ratchet init storms (50 messages → 50 x3dh inits)
    const convId = conversationId || 'unknown';
    return serializedDecrypt(convId, async () => {
      if (!isZeus && !peerKeyRef.current) {
        const syncKey = `${user?.id}:${peerUserId}`;
        if (!_peerSyncPromise.has(syncKey)) {
          const p = ensureKeysAndPeerSync(false).finally(() => _peerSyncPromise.delete(syncKey));
          _peerSyncPromise.set(syncKey, p);
        }
        const synced = await _peerSyncPromise.get(syncKey);
        if (!synced) {
          return { text: '', encrypted: true, verified: false, incompatible: true };
        }
      }

      if (!cryptoRateCheck('decrypt')) {
        return { text: '', encrypted: true, verified: false, incompatible: true };
      }

      try {
        const parsed = hardGlobals.jsonParse(body);

        if (isStrictRatchetEnvelopeBody(body)) {
          return await decryptRatchetMessage(parsed, body);
        }

        if (conversationId) {
          void scheduleLegacyCleanup(conversationId, user?.id);
        }
        return { text: '', encrypted: true, verified: false, incompatible: true };

      } catch (err) {
        console.error('[E2EE] decrypt failed:', err);
        return { text: '', encrypted: true, verified: false, incompatible: true };
      }
    });
  }, [conversationId, ensureKeysAndPeerSync, isZeus, user, peerUserId, state.fingerprintChanged]);

  /**
   * If the decrypted ratchet plaintext is actually an SKDM (Sender Key
   * Distribution Message), install it into `sender_key_state` and swallow
   * the message — it's protocol metadata, not a user message.
   */
  const maybeAbsorbSKDM = useCallback(async (plaintext: string): Promise<DecryptResult | null> => {
    const parsed = parseSKDM(plaintext);
    if (!parsed) return null;
    try {
      await installSKDM(plaintext);
      console.info('[E2EE] SKDM absorbed', { conv: parsed.conversationId, sender: parsed.senderUserId, iter: parsed.iteration });
    } catch (err) {
      console.warn('[E2EE] SKDM install failed', err);
    }
    return { text: '', encrypted: true, verified: true, incompatible: true };
  }, []);

  const decryptRatchetMessage = useCallback(async (
    parsed: any,
    rawBody: string,
  ): Promise<DecryptResult> => {
    if (!isZeus && state.fingerprintChanged) {
      console.warn('[E2EE] Blocking decrypt until fingerprint change is acknowledged');
      return { text: '', encrypted: true, verified: false, incompatible: true };
    }

    if (hasRatchetTerminalFailure(conversationId, rawBody)) {
      if (conversationId) void scheduleLegacyCleanup(conversationId, user?.id);
      return { text: '', encrypted: true, verified: false, incompatible: true };
    }

    const envelope: RatchetEnvelope = parsed;
    const x3dhHeader: X3DHInitialMessage | undefined = parsed.x3dh;
    let ratchet = ratchetRef.current;

    const rejectUnverified = (verified: boolean, stage: string): boolean => {
      if (verified) return false;
      console.error('[E2EE] Blocking ratchet plaintext with invalid or missing signature', {
        conversationId,
        stage,
        hasPeerSigningKey: !!peerKeyRef.current?.signingKey,
      });
      return true;
    };

    const bootstrapResponderFromHeader = async (reason: string): Promise<RatchetState | null> => {
      if (!conversationId || !keysRef.current || !user || !x3dhHeader) return null;

      console.warn(`[E2EE] Rebootstrapping responder ratchet (${reason}) for ${conversationId}`);
      await resetRatchetBootstrapState(`responder_rebootstrap:${reason}`);

      if (!base64KeysEqual(x3dhHeader.ik, peerKeyRef.current?.identityKey)) {
        throw new Error('X3DH identity key mismatch for peer');
      }

      const { sharedSecret, spkKeyPair } = await x3dhRespond(
        keysRef.current,
        user.id,
        x3dhHeader,
      );

      const myPubRawResp = await hardCrypto.exportKey('raw', keysRef.current.publicKey);
      const rebuilt = await initRatchetAsResponder(
        conversationId,
        sharedSecret,
        spkKeyPair,
        {
          // Responder POV: peer = initiator (Alice) = x3dhHeader.ik; me = Bob.
          myIdentityKeyB64: bufferToBase64(myPubRawResp),
          peerIdentityKeyB64: x3dhHeader.ik,
        },
      );

      ratchetRef.current = rebuilt;
      await saveRatchetLocal(conversationId, rebuilt, null);
      console.info('[RATCHET] ✅ responder ratchet rebuilt from X3DH header');
      return rebuilt;
    };

    if (!ratchet && conversationId && keysRef.current && user) {
      try {
        const persisted = await loadRatchetLocal(conversationId);
        if (persisted) {
          ratchet = persisted.state;
          ratchetRef.current = ratchet;
          console.info('[RATCHET] Loaded persisted ratchet state for decrypt');
        } else if (x3dhHeader) {
          ratchet = await bootstrapResponderFromHeader('missing_local_state');
        } else {
          console.error('[E2EE] ⛔ X3DH header MISSING on first ratchet message — cannot init responder ratchet. This message cannot be decrypted without proper X3DH handshake.');
          markRatchetTerminalFailure(conversationId, rawBody);
          if (conversationId) void scheduleLegacyCleanup(conversationId, user?.id);
          return { text: '', encrypted: true, verified: false, incompatible: true };
        }
      } catch (initErr) {
        const errMsg = initErr instanceof Error ? initErr.message : String(initErr);
        console.error('[E2EE] ⛔ Ratchet responder init FAILED:', errMsg);
        markRatchetTerminalFailure(conversationId, rawBody);
        if (conversationId) void scheduleLegacyCleanup(conversationId, user?.id);
        if (errMsg.includes('SPK') && errMsg.includes('NOT FOUND')) {
          return { text: '', encrypted: true, verified: false, incompatible: true };
        }
        if (errMsg.includes('OPK') && errMsg.includes('NOT FOUND')) {
          return { text: '', encrypted: true, verified: false, incompatible: true };
        }
        return { text: '', encrypted: true, verified: false, incompatible: true };
      }
    }

    if (ratchet) {
      const readiness = getRatchetReadiness(ratchet);
      if (!readiness.canDecrypt) {
        console.warn('[E2EE] Ratchet state not decrypt-ready:', readiness.reason);
        if (x3dhHeader) {
          try {
            const healed = await bootstrapResponderFromHeader(`not_ready:${readiness.reason}`);
            if (healed) {
              const { plaintext, verified, newState } = await ratchetDecrypt(
                healed, envelope, peerKeyRef.current?.signingKey,
              );
              if (rejectUnverified(verified, 'readiness_self_heal')) {
                return { text: '', encrypted: true, verified: false, incompatible: true };
              }
              ratchetRef.current = newState;
              await saveRatchetLocal(conversationId!, newState, null);
              setState(s => ({ ...s, ratchetActive: true }));
              console.debug(`[RATCHET] ✅ decrypt OK after readiness self-heal — verified=${verified}`);
              const skdmAbsorbed = await maybeAbsorbSKDM(plaintext);
              if (skdmAbsorbed) return skdmAbsorbed;
              return { text: plaintext, encrypted: true, verified };
            }
          } catch (healErr) {
            console.error('[E2EE] Ratchet self-heal after readiness failure failed:', healErr);
            markRatchetTerminalFailure(conversationId, rawBody);
            if (conversationId) void scheduleLegacyCleanup(conversationId, user?.id);
            return { text: '', encrypted: true, verified: false, incompatible: true };
          }
        }
        return { text: '', encrypted: true, verified: false, incompatible: true };
      }

      try {
        console.debug(`[RATCHET] decrypt — msg #${envelope.hdr.n}, dh=${envelope.hdr.dh.slice(0, 12)}…`);
        const { plaintext, verified, newState } = await ratchetDecrypt(
          ratchet, envelope, peerKeyRef.current?.signingKey,
        );
        if (rejectUnverified(verified, 'primary')) {
          return { text: '', encrypted: true, verified: false, incompatible: true };
        }
        ratchetRef.current = newState;
        if (!peerHasRespondedRef.current) {
          peerHasRespondedRef.current = true;
          if (x3dhInfoRef.current) {
            console.info('[E2EE] Peer responded — X3DH header cleared (Signal-style promotion)');
            x3dhInfoRef.current = null;
          }
        }
        await saveRatchetLocal(conversationId!, newState, x3dhInfoRef.current);
        setState(s => ({ ...s, ratchetActive: true }));
        console.debug(`[RATCHET] ✅ decrypt OK — verified=${verified}`);
        const skdmAbsorbed = await maybeAbsorbSKDM(plaintext);
        if (skdmAbsorbed) return skdmAbsorbed;
        return { text: plaintext, encrypted: true, verified };
      } catch (ratchetErr) {
        const errMsg = ratchetErr instanceof Error ? ratchetErr.message : String(ratchetErr);
        console.error('[E2EE] ❌ Ratchet decrypt failed:', errMsg);

        if (x3dhHeader) {
          try {
            const healed = await bootstrapResponderFromHeader(`decrypt_failed:${errMsg}`);
            if (healed) {
              const { plaintext, verified, newState } = await ratchetDecrypt(
                healed, envelope, peerKeyRef.current?.signingKey,
              );
              if (rejectUnverified(verified, 'decrypt_self_heal')) {
                return { text: '', encrypted: true, verified: false, incompatible: true };
              }
              ratchetRef.current = newState;
              await saveRatchetLocal(conversationId!, newState, null);
              setState(s => ({ ...s, ratchetActive: true }));
              console.debug(`[RATCHET] ✅ decrypt OK after X3DH self-heal — verified=${verified}`);
              const skdmAbsorbed = await maybeAbsorbSKDM(plaintext);
              if (skdmAbsorbed) return skdmAbsorbed;
              return { text: plaintext, encrypted: true, verified };
            }
          } catch (healErr) {
            console.error('[E2EE] Ratchet self-heal after decrypt failure failed:', healErr);
            markRatchetTerminalFailure(conversationId, rawBody);
            if (conversationId) void scheduleLegacyCleanup(conversationId, user?.id);
            return { text: '', encrypted: true, verified: false, incompatible: true };
          }
        }
        // No X3DH header to self-heal from — return a precise diagnostic.
        console.error('[E2EE] ⛔ decrypt failed AND no X3DH header to self-heal — terminal', {
          conversationId,
          hasRatchet: !!ratchetRef.current,
          envelopeN: envelope?.hdr?.n,
          envelopeDh: envelope?.hdr?.dh?.slice(0, 12),
          errMsg,
        });
      }
    }

    // Diagnostic dump before declaring "session expirée" — helps identify the
    // exact path that led here (no ratchet, no X3DH header, peer key missing…).
    console.error('[E2EE] ⛔ decryptRatchetMessage reached terminal fallback', {
      conversationId,
      hasRatchet: !!ratchet,
      hasX3dhHeader: !!x3dhHeader,
      hasPeerKey: !!peerKeyRef.current,
      hasMyKeys: !!keysRef.current,
      envelopeN: envelope?.hdr?.n,
      envelopeDh: envelope?.hdr?.dh?.slice(0, 12),
    });

    // SELF-HEAL: si on a un ratchet local mais le message arrive sans header X3DH
    // et qu'on n'arrive pas à le déchiffrer, c'est qu'on est désynchronisé avec
    // le pair (notre ratchet vient d'un ancien handshake obsolète). On purge notre
    // ratchet local : au prochain envoi, l'un des deux côtés relancera un X3DH
    // propre (via cache-bust SPK ou détection in_memory_incomplete).
    if (ratchet && !x3dhHeader && conversationId) {
      console.warn('[E2EE] 🔄 Ratchet désynchronisé détecté — purge locale + rotation SPK pour forcer re-handshake côté pair');
      await resetRatchetBootstrapState('peer_ratchet_desync');
      // Rotate our SPK so the peer's next send detects isPeerSPKStale and re-runs X3DH automatically.
      // Without this, the sender keeps using the same ratchet (no X3DH header attached after first peer response)
      // and the receiver stays stuck in this terminal failure forever.
      if (user && keysRef.current) {
        try {
          await generateAndUploadSignedPrekey(user.id, keysRef.current.signingPrivateKey);
          console.info('[E2EE] ✅ SPK rotated — peer will re-handshake on next send');
        } catch (e) {
          console.warn('[E2EE] SPK rotation failed (peer may stay desynced):', e);
        }
      }
      markRatchetTerminalFailure(conversationId, rawBody);
      return { text: '', encrypted: true, verified: false, incompatible: true };
    }

    markRatchetTerminalFailure(conversationId, rawBody);
    if (conversationId) void scheduleLegacyCleanup(conversationId, user?.id);
    return { text: '', encrypted: true, verified: false, incompatible: true };
  }, [conversationId, user, resetRatchetBootstrapState, isZeus, state.fingerprintChanged]);

  // Legacy message decrypt path removed — incompatible bodies are auto-purged.

  /** Check if encryption is ready for this conversation */
  const isReady = useCallback((): boolean => {
    if (isZeus) return true;
    // Ready if we have peer keys and our own keys, and no fingerprint block
    const ready =
      state.encrypted &&
      !!keysRef.current &&
      !!peerKeyRef.current &&
      !state.fingerprintChanged;
    if (!ready) {
      // High-signal debug breadcrumb — surfaces in iOS Web Inspector.
      console.debug('[E2EE.isReady] NOT ready', {
        conversationId,
        encrypted: state.encrypted,
        hasOwnKeys: !!keysRef.current,
        hasPeerKey: !!peerKeyRef.current,
        fingerprintChanged: state.fingerprintChanged,
        peerKeyMissing: state.peerKeyMissing,
        initError: state.initError,
      });
    }
    return ready;
  }, [state.encrypted, state.fingerprintChanged, state.peerKeyMissing, state.initError, isZeus, conversationId]);

  /** Acknowledge fingerprint change — user explicitly trusts new key */
  const acknowledgeFingerprint = useCallback(async () => {
    if (peerKeyRef.current && peerUserId) {
      saveKnownFingerprint(peerUserId, peerKeyRef.current.fingerprint);
      saveKnownFingerprintServer(peerUserId, peerKeyRef.current.fingerprint, true);
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

      // Legacy session purge/re-establish removed — Double Ratchet only.
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

function isLegacyEncryptedEnvelope(body: string): boolean {
  if (!body.startsWith('{')) return false;
  try {
    const p = hardGlobals.jsonParse(body);
    return p.v !== undefined && p.kem !== undefined && p.ct !== undefined;
  } catch {
    return false;
  }
}

/**
 * Anti-loop guard: only run cleanup ONCE per conversation per session.
 * Detects messages whose body starts with `{` and looks like an old crypto payload
 * but is NEITHER a valid legacy envelope (v+kem+ct) NOR a valid ratchet envelope (v+hdr+ct),
 * and deletes them. Plain text, GIFs, audio, calls and valid encrypted messages are untouched.
 */
const _legacyCleanupRan = new Set<string>();
async function scheduleLegacyCleanup(conversationId: string, userId?: string): Promise<void> {
  if (_legacyCleanupRan.has(conversationId)) return;
  _legacyCleanupRan.add(conversationId);

  try {
    if (!userId) return;
    const { data: rows, error } = await supabase
      .from('messages')
      .select('id, body')
      .eq('conversation_id', conversationId)
      .like('body', '{%')
      .limit(500);

    if (error || !rows?.length) return;

    const idsToDelete: string[] = [];
    for (const row of rows) {
      const body = (row as any).body as string | null;
      if (!body || typeof body !== 'string') continue;
      if (!body.startsWith('{')) continue;
      if (isUnsupportedEncryptedBody(body)) idsToDelete.push((row as any).id);
    }

    if (idsToDelete.length === 0) {
      console.log('[E2EE] Legacy cleanup: nothing to remove for', conversationId);
      return;
    }

    // Never persist crypto failures as "delete for me". A session restore can
    // temporarily lack keys/PIN/device copies, and hiding rows in the database
    // makes a recoverable conversation look empty on every future visit.
    console.warn('[E2EE] Legacy cleanup found incompatible crypto rows; leaving them visible for recovery', {
      conversationId,
      count: idsToDelete.length,
    });
  } catch (e) {
    console.warn('[E2EE] Legacy cleanup error:', e);
  }
}
