/**
 * Account-identity trust tracker.
 *
 * First contact uses TOFU. A manual "Je fais confiance" decision confirms the
 * exact account fingerprint currently displayed; it never authorizes a future
 * account identity. Device keys, Signed PreKeys and ratchet keys may rotate
 * under the same account identity without changing this fingerprint.
 */

import { supabase } from '@/integrations/supabase/client';
import { hardGlobals } from './cryptoIntegrity';
import { fetchPeerPublicKeys, getCachedAuthUserId } from './peerKeyCache';

export const KNOWN_FP_KEY = 'forsure-known-fps';

export type FingerprintCheckResult = {
  changed: boolean;
  previousFp: string | null;
};

function storageKey(observerUserId: string, peerUserId: string): string {
  return `${observerUserId}:${peerUserId}`;
}

export function getKnownFingerprints(): Record<string, string> {
  try {
    const parsed = hardGlobals.jsonParse(
      localStorage.getItem(KNOWN_FP_KEY) || '{}',
    ) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed ?? {}).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && entry[1].length > 0,
      ),
    );
  } catch {
    return {};
  }
}

export function getKnownFingerprint(
  observerUserId: string,
  peerUserId: string,
): string | null {
  return getKnownFingerprints()[storageKey(observerUserId, peerUserId)] ?? null;
}

export function saveKnownFingerprint(
  observerUserId: string,
  peerUserId: string,
  fingerprint: string,
): void {
  if (!observerUserId || !peerUserId || !fingerprint) return;
  const known = getKnownFingerprints();
  known[storageKey(observerUserId, peerUserId)] = fingerprint;
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
  try {
    const observerUserId = await getCachedAuthUserId();
    if (!observerUserId) return false;

    const cacheKey = `${observerUserId}:${peerUserId}:${fingerprint}:${verifiedByUser ? 1 : 0}`;
    const lastSavedAt = fingerprintSaveCache.get(cacheKey);
    if (!verifiedByUser && lastSavedAt && Date.now() - lastSavedAt < CACHE_TTL_MS) {
      return true;
    }

    const row = {
      user_id: observerUserId,
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

    fingerprintSaveCache.set(cacheKey, Date.now());
    saveKnownFingerprint(observerUserId, peerUserId, fingerprint);
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
    const { recordIdentityChange } = await import('@/lib/crypto/identityChangeLedger');
    await recordIdentityChange({
      ...input,
      changeType: 'identity_rotation',
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
  const localPrevious = getKnownFingerprint(currentUserId, peerUserId);
  const cacheKey = `${currentUserId}:${peerUserId}:${currentFingerprint}`;

  const cached = fingerprintCheckCache.get(cacheKey);
  if (
    cached &&
    !cached.result.changed &&
    Date.now() - cached.timestamp < CACHE_TTL_MS
  ) {
    return cached.result;
  }

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
    // A known local identity remains usable during a transient server outage.
    // A first contact is persisted before the route becomes ready.
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
    saveKnownFingerprint(currentUserId, peerUserId, currentFingerprint);
  }

  const result = { changed: false, previousFp: null };
  fingerprintCheckCache.set(cacheKey, { result, timestamp: Date.now() });
  return result;
}

/**
 * Core transport gate. Background retries call this as well, so no UI race can
 * send after an untrusted account identity replacement.
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
    const peerKeys = await fetchPeerPublicKeys(peerUserId, { forceRefresh: true });
    if (!peerKeys) throw new Error('PEER_IDENTITY_BINDING_UNAVAILABLE');

    const check = await checkFingerprintChangeWithServer(
      currentUserId,
      peerUserId,
      peerKeys.fingerprint,
    );
    if (check.changed) throw new Error('FINGERPRINT_CHANGED');

    if (!getKnownFingerprint(currentUserId, peerUserId)) {
      const persisted = await saveKnownFingerprintServer(
        peerUserId,
        peerKeys.fingerprint,
        false,
      );
      if (!persisted) throw new Error('FINGERPRINT_TRUST_PERSIST_FAILED');
      saveKnownFingerprint(currentUserId, peerUserId, peerKeys.fingerprint);
    }
  }));
}

export function checkFingerprintChange(
  observerUserId: string,
  peerUserId: string,
  currentFingerprint: string,
): boolean {
  const previousFingerprint = getKnownFingerprint(observerUserId, peerUserId);
  return Boolean(previousFingerprint && previousFingerprint !== currentFingerprint);
}
