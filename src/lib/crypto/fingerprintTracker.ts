/**
 * Account-identity trust tracker.
 *
 * First contact uses TOFU. Once an account identity has been observed, every
 * change is fail-closed until the user explicitly accepts the new safety
 * number. Recovery markers only explain a change; they never auto-authorize it.
 */

import { supabase } from '@/integrations/supabase/client';
import { hardGlobals } from './cryptoIntegrity';
import {
  fetchPeerPublicKeys,
  getCachedAuthUserId,
} from './peerKeyCache';

export const KNOWN_FP_KEY = 'forsure-known-fps';

export type FingerprintCheckResult = {
  changed: boolean;
  previousFp: string | null;
};

export function getKnownFingerprints(): Record<string, string> {
  try {
    return hardGlobals.jsonParse(localStorage.getItem(KNOWN_FP_KEY) || '{}');
  } catch {
    return {};
  }
}

export function saveKnownFingerprint(userId: string, fingerprint: string): void {
  const known = getKnownFingerprints();
  known[userId] = fingerprint;
  localStorage.setItem(KNOWN_FP_KEY, hardGlobals.jsonStringify(known));
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

export async function saveKnownFingerprintServer(
  peerUserId: string,
  fingerprint: string,
  verifiedByUser = false,
): Promise<boolean> {
  const cacheKey = `${peerUserId}:${fingerprint}`;
  const lastSavedAt = fingerprintSaveCache.get(cacheKey);
  if (!verifiedByUser && lastSavedAt && Date.now() - lastSavedAt < CACHE_TTL_MS) return true;

  try {
    const userId = await getCachedAuthUserId();
    if (!userId) return false;
    const row = {
      user_id: userId,
      peer_user_id: peerUserId,
      fingerprint,
      last_seen_at: new Date().toISOString(),
      acknowledged: verifiedByUser,
      verified_manually: verifiedByUser,
    };
    const { error } = verifiedByUser
      ? await supabase
        .from('user_known_fingerprints')
        .upsert(row, { onConflict: 'user_id,peer_user_id' })
      : await supabase
        .from('user_known_fingerprints')
        .upsert(row, {
          onConflict: 'user_id,peer_user_id',
          ignoreDuplicates: true,
        });
    if (error) throw error;
    // A passive TOFU observation must never downgrade a previous manual
    // verification. Cache only a confirmed write so transient failures retry.
    fingerprintSaveCache.set(cacheKey, Date.now());
    invalidateFingerprintCheckCache(peerUserId);
    return true;
  } catch (error) {
    console.warn('[E2EE] Server fingerprint save failed', error);
    return false;
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

/** Check the composite X25519+Ed25519 fingerprint against local and server trust. */
export async function checkFingerprintChangeWithServer(
  currentUserId: string,
  peerUserId: string,
  currentFingerprint: string,
): Promise<FingerprintCheckResult> {
  const localPrevious = getKnownFingerprints()[peerUserId] ?? null;
  const cacheKey = `${currentUserId}:${peerUserId}:${currentFingerprint}`;
  const cached = fingerprintCheckCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.result;

  let serverPrevious: string | null = null;
  try {
    const { data, error } = await supabase
      .from('user_known_fingerprints')
      .select('fingerprint')
      .eq('user_id', currentUserId)
      .eq('peer_user_id', peerUserId)
      .maybeSingle();
    if (error) throw error;
    serverPrevious = data?.fingerprint ?? null;
  } catch {
    // Local trust remains authoritative while the server is temporarily
    // unreachable. A missing local record is first contact, not a rotation.
  }

  const previousFingerprint = serverPrevious ?? localPrevious;
  if (previousFingerprint && previousFingerprint !== currentFingerprint) {
    await recordChange({
      observerUserId: currentUserId,
      peerUserId,
      previousFingerprint,
      newFingerprint: currentFingerprint,
    });
    const result = { changed: true, previousFp: previousFingerprint };
    fingerprintCheckCache.set(cacheKey, { result, timestamp: Date.now() });
    return result;
  }

  if (previousFingerprint === currentFingerprint && localPrevious !== currentFingerprint) {
    saveKnownFingerprint(peerUserId, currentFingerprint);
  }
  const result = { changed: false, previousFp: null };
  fingerprintCheckCache.set(cacheKey, { result, timestamp: Date.now() });
  return result;
}

/**
 * Core transport gate. Background retries call this as well, so no UI race can
 * send after an account identity rotation that has not been acknowledged.
 */
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
    // The core send gate intentionally bypasses the performance cache. A
    // two-minute cached identity would otherwise allow messages to leave after
    // a peer account key changed.
    const peerKeys = await fetchPeerPublicKeys(peerUserId, { forceRefresh: true });
    if (!peerKeys) throw new Error('PEER_IDENTITY_BINDING_UNAVAILABLE');

    const check = await checkFingerprintChangeWithServer(
      currentUserId,
      peerUserId,
      peerKeys.fingerprint,
    );
    if (check.changed) throw new Error('FINGERPRINT_CHANGED');

    if (!getKnownFingerprints()[peerUserId]) {
      saveKnownFingerprint(peerUserId, peerKeys.fingerprint);
      await saveKnownFingerprintServer(peerUserId, peerKeys.fingerprint, false);
    }
  }));
}

export function checkFingerprintChange(userId: string, currentFingerprint: string): boolean {
  const previousFingerprint = getKnownFingerprints()[userId];
  return Boolean(previousFingerprint && previousFingerprint !== currentFingerprint);
}
