/**
 * Account-identity trust tracker.
 *
 * Local continuity is authoritative. Server synchronization is accepted only
 * when the trust row carries a valid Ed25519 signature from this account's own
 * stable identity key. A server row can never replace an already-known local
 * fingerprint.
 */

import { supabase } from '@/integrations/supabase/client';
import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import { getOrCreateIdentityKeys } from './keyManager';
import {
  base64ToBuffer,
  bufferToBase64,
  encodeString,
} from './utils';
import {
  fetchPeerPublicKeys,
  getCachedAuthUserId,
} from './peerKeyCache';

export const KNOWN_FP_KEY = 'forsure-known-fps';
const SCOPED_FP_PREFIX = 'forsure-known-fps-v2:';
const TRUST_PROTOCOL = 'forsure-aegis-known-fingerprint';
const TRUST_VERSION = 1;
const FINGERPRINT_RE = /^[0-9a-f ]{32,160}$/i;

export type FingerprintCheckResult = {
  changed: boolean;
  previousFp: string | null;
  source?: 'local' | 'signed_server' | 'first_contact';
};

type SignedTrustRow = {
  fingerprint: string;
  acknowledged: boolean;
  verified_manually: boolean;
  trust_version: number | null;
  observer_signature: string | null;
};

function normalizeFingerprint(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

function readJsonRecord(key: string): Record<string, string> {
  try {
    const parsed = hardGlobals.jsonParse(localStorage.getItem(key) || '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

export function getKnownFingerprints(observerUserId?: string): Record<string, string> {
  return readJsonRecord(observerUserId ? `${SCOPED_FP_PREFIX}${observerUserId}` : KNOWN_FP_KEY);
}

function getLegacyKnownFingerprint(peerUserId: string): string | null {
  return getKnownFingerprints()[peerUserId] ?? null;
}

export function saveKnownFingerprint(
  peerUserId: string,
  fingerprint: string,
  observerUserId?: string,
): void {
  const normalized = normalizeFingerprint(fingerprint);
  if (!FINGERPRINT_RE.test(normalized)) throw new Error('INVALID_ACCOUNT_FINGERPRINT');
  const key = observerUserId ? `${SCOPED_FP_PREFIX}${observerUserId}` : KNOWN_FP_KEY;
  const known = readJsonRecord(key);
  known[peerUserId] = normalized;
  localStorage.setItem(key, hardGlobals.jsonStringify(known));
}

function canonicalTrustPayload(input: {
  observerUserId: string;
  peerUserId: string;
  fingerprint: string;
  acknowledged: boolean;
  verifiedManually: boolean;
}): string {
  return JSON.stringify({
    protocol: TRUST_PROTOCOL,
    version: TRUST_VERSION,
    observerUserId: input.observerUserId,
    peerUserId: input.peerUserId,
    fingerprint: normalizeFingerprint(input.fingerprint),
    acknowledged: input.acknowledged,
    verifiedManually: input.verifiedManually,
  });
}

async function signTrustPayload(input: {
  observerUserId: string;
  peerUserId: string;
  fingerprint: string;
  acknowledged: boolean;
  verifiedManually: boolean;
}): Promise<string> {
  const identity = await getOrCreateIdentityKeys(input.observerUserId);
  return bufferToBase64(await hardCrypto.sign(
    'Ed25519',
    identity.signingPrivateKey,
    encodeString(canonicalTrustPayload(input)),
  ) as ArrayBuffer);
}

async function verifyTrustRow(input: {
  observerUserId: string;
  peerUserId: string;
  row: SignedTrustRow;
}): Promise<boolean> {
  if (
    input.row.trust_version !== TRUST_VERSION ||
    !input.row.observer_signature ||
    !FINGERPRINT_RE.test(normalizeFingerprint(input.row.fingerprint))
  ) return false;
  try {
    const identity = await getOrCreateIdentityKeys(input.observerUserId);
    return await hardCrypto.verify(
      'Ed25519',
      identity.signingPublicKey,
      base64ToBuffer(input.row.observer_signature),
      encodeString(canonicalTrustPayload({
        observerUserId: input.observerUserId,
        peerUserId: input.peerUserId,
        fingerprint: input.row.fingerprint,
        acknowledged: input.row.acknowledged,
        verifiedManually: input.row.verified_manually,
      })),
    );
  } catch {
    return false;
  }
}

const fingerprintCheckCache = new Map<
  string,
  { result: FingerprintCheckResult; timestamp: number }
>();
const fingerprintSaveCache = new Map<string, number>();
const CACHE_TTL_MS = 60_000;

export function invalidateFingerprintCheckCache(peerUserId: string): void {
  for (const key of fingerprintCheckCache.keys()) {
    if (key.includes(`:${peerUserId}:`)) fingerprintCheckCache.delete(key);
  }
}

async function readSignedServerTrust(
  observerUserId: string,
  peerUserId: string,
): Promise<SignedTrustRow | null> {
  try {
    const { data, error } = await (supabase as any)
      .from('user_known_fingerprints')
      .select('fingerprint,acknowledged,verified_manually,trust_version,observer_signature')
      .eq('user_id', observerUserId)
      .eq('peer_user_id', peerUserId)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as SignedTrustRow;
    if (!await verifyTrustRow({ observerUserId, peerUserId, row })) {
      console.warn('[E2EE] Ignoring unsigned or invalid server trust row', { peerUserId });
      return null;
    }
    return row;
  } catch {
    return null;
  }
}

export async function saveKnownFingerprintServer(
  peerUserId: string,
  fingerprint: string,
  verifiedByUser = false,
): Promise<void> {
  const normalized = normalizeFingerprint(fingerprint);
  if (!FINGERPRINT_RE.test(normalized)) throw new Error('INVALID_ACCOUNT_FINGERPRINT');
  const cacheKey = `${peerUserId}:${normalized}:${verifiedByUser ? 'manual' : 'tofu'}`;
  const lastSavedAt = fingerprintSaveCache.get(cacheKey);
  if (!verifiedByUser && lastSavedAt && Date.now() - lastSavedAt < CACHE_TTL_MS) return;

  try {
    const observerUserId = await getCachedAuthUserId();
    if (!observerUserId) return;
    const existing = await readSignedServerTrust(observerUserId, peerUserId);
    if (
      existing &&
      normalizeFingerprint(existing.fingerprint) !== normalized &&
      !verifiedByUser
    ) {
      // A passive observation can never replace a signed trust decision.
      return;
    }

    const verifiedManually = verifiedByUser || Boolean(
      existing?.verified_manually && normalizeFingerprint(existing.fingerprint) === normalized,
    );
    const acknowledged = verifiedManually || Boolean(
      existing?.acknowledged && normalizeFingerprint(existing.fingerprint) === normalized,
    );
    const observerSignature = await signTrustPayload({
      observerUserId,
      peerUserId,
      fingerprint: normalized,
      acknowledged,
      verifiedManually,
    });
    const row = {
      user_id: observerUserId,
      peer_user_id: peerUserId,
      fingerprint: normalized,
      last_seen_at: new Date().toISOString(),
      acknowledged,
      verified_manually: verifiedManually,
      trust_version: TRUST_VERSION,
      observer_signature: observerSignature,
    };
    const { error } = await (supabase as any)
      .from('user_known_fingerprints')
      .upsert(row, { onConflict: 'user_id,peer_user_id' });
    if (error) throw error;
    fingerprintSaveCache.set(cacheKey, Date.now());
    invalidateFingerprintCheckCache(peerUserId);
  } catch (error) {
    console.warn('[E2EE] Signed server fingerprint save failed', error);
  }
}

async function recordChange(input: {
  observerUserId: string;
  peerUserId: string;
  previousFingerprint: string;
  newFingerprint: string;
}): Promise<void> {
  try {
    const [{ recordIdentityChange }, { peerHasRecentRecoveryMarker }] = await Promise.all([
      import('@/lib/crypto/identityChangeLedger'),
      import('@/lib/crypto/recoveryMarkers'),
    ]);
    const recovery = await peerHasRecentRecoveryMarker(
      input.peerUserId,
      input.newFingerprint,
    );
    await recordIdentityChange({
      ...input,
      changeType: recovery ? 'recovery_restore' : 'identity_rotation',
    });
  } catch (error) {
    console.warn('[E2EE] Identity change ledger unavailable', error);
  }
}

/** Local trust always wins; only a valid account-signed server row may seed a new device. */
export async function checkFingerprintChangeWithServer(
  currentUserId: string,
  peerUserId: string,
  currentFingerprint: string,
): Promise<FingerprintCheckResult> {
  const current = normalizeFingerprint(currentFingerprint);
  if (!FINGERPRINT_RE.test(current)) throw new Error('INVALID_ACCOUNT_FINGERPRINT');
  const scopedPrevious = getKnownFingerprints(currentUserId)[peerUserId] ?? null;
  const legacyPrevious = scopedPrevious ? null : getLegacyKnownFingerprint(peerUserId);
  const localPrevious = scopedPrevious ?? legacyPrevious;
  const cacheKey = `${currentUserId}:${peerUserId}:${current}`;
  const cached = fingerprintCheckCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.result;

  const signedServer = await readSignedServerTrust(currentUserId, peerUserId);
  const signedServerPrevious = signedServer
    ? normalizeFingerprint(signedServer.fingerprint)
    : null;

  if (localPrevious) {
    const local = normalizeFingerprint(localPrevious);
    if (local !== current) {
      await recordChange({
        observerUserId: currentUserId,
        peerUserId,
        previousFingerprint: local,
        newFingerprint: current,
      });
      const result = { changed: true, previousFp: local, source: 'local' as const };
      fingerprintCheckCache.set(cacheKey, { result, timestamp: Date.now() });
      return result;
    }

    if (!scopedPrevious) saveKnownFingerprint(peerUserId, current, currentUserId);
    if (signedServerPrevious && signedServerPrevious !== local) {
      console.warn('[E2EE] Signed trust store conflicts with local continuity; local value retained', {
        peerUserId,
      });
    }
    const result = { changed: false, previousFp: null, source: 'local' as const };
    fingerprintCheckCache.set(cacheKey, { result, timestamp: Date.now() });
    return result;
  }

  if (signedServerPrevious && signedServerPrevious !== current) {
    await recordChange({
      observerUserId: currentUserId,
      peerUserId,
      previousFingerprint: signedServerPrevious,
      newFingerprint: current,
    });
    const result = {
      changed: true,
      previousFp: signedServerPrevious,
      source: 'signed_server' as const,
    };
    fingerprintCheckCache.set(cacheKey, { result, timestamp: Date.now() });
    return result;
  }

  saveKnownFingerprint(peerUserId, current, currentUserId);
  const result = {
    changed: false,
    previousFp: null,
    source: signedServerPrevious ? 'signed_server' as const : 'first_contact' as const,
  };
  fingerprintCheckCache.set(cacheKey, { result, timestamp: Date.now() });
  return result;
}

export async function acceptPeerFingerprint(input: {
  currentUserId: string;
  peerUserId: string;
  fingerprint: string;
}): Promise<void> {
  const normalized = normalizeFingerprint(input.fingerprint);
  saveKnownFingerprint(input.peerUserId, normalized, input.currentUserId);
  // Keep the legacy local store updated for old UI components during rollout.
  saveKnownFingerprint(input.peerUserId, normalized);
  await saveKnownFingerprintServer(input.peerUserId, normalized, true);
  invalidateFingerprintCheckCache(input.peerUserId);
}

/** Core transport gate: identity rotations fail closed until explicit acceptance. */
export async function assertConversationFingerprintsTrusted(
  currentUserId: string,
  conversationId: string,
): Promise<void> {
  const { data: participants, error } = await supabase
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', conversationId);
  if (error) throw error;

  const peerUserIds = Array.from(new Set((participants ?? [])
    .map((participant) => participant.user_id)
    .filter((userId): userId is string => Boolean(userId) && userId !== currentUserId)));

  await Promise.all(peerUserIds.map(async (peerUserId) => {
    const hadTrustedPrevious = Boolean(
      getKnownFingerprints(currentUserId)[peerUserId] || getLegacyKnownFingerprint(peerUserId),
    );
    const peerKeys = await fetchPeerPublicKeys(peerUserId, { forceRefresh: true });
    if (!peerKeys) throw new Error('PEER_IDENTITY_BINDING_UNAVAILABLE');

    const check = await checkFingerprintChangeWithServer(
      currentUserId,
      peerUserId,
      peerKeys.fingerprint,
    );
    if (check.changed) throw new Error('FINGERPRINT_CHANGED');
    if (!hadTrustedPrevious) {
      await saveKnownFingerprintServer(peerUserId, peerKeys.fingerprint, false);
    }
  }));
}

export function checkFingerprintChange(
  peerUserId: string,
  currentFingerprint: string,
  observerUserId?: string,
): boolean {
  const previous = getKnownFingerprints(observerUserId)[peerUserId]
    ?? (observerUserId ? getLegacyKnownFingerprint(peerUserId) : null);
  return Boolean(previous && normalizeFingerprint(previous) !== normalizeFingerprint(currentFingerprint));
}

export const __test__ = {
  canonicalTrustPayload,
  normalizeFingerprint,
  signTrustPayload,
  verifyTrustRow,
  trustProtocol: TRUST_PROTOCOL,
  trustVersion: TRUST_VERSION,
};
