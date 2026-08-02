/**
 * Account-identity trust tracker.
 *
 * First contact uses TOFU. Before an explicit user decision, identity changes
 * fail closed. Once the user selects "Je fais confiance", trust becomes a
 * persistent contact-level decision: later key rotations update the observed
 * fingerprint but do not block messaging again.
 */

import { supabase } from '@/integrations/supabase/client';
import { hardGlobals } from './cryptoIntegrity';
import {
  fetchPeerPublicKeys,
  getCachedAuthUserId,
} from './peerKeyCache';

export const KNOWN_FP_KEY = 'forsure-known-fps';
export const MANUAL_TRUST_CONTACTS_KEY = 'forsure-manual-trust-contacts';

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

export function getManuallyTrustedContacts(): Record<string, true> {
  try {
    const parsed = hardGlobals.jsonParse(
      localStorage.getItem(MANUAL_TRUST_CONTACTS_KEY) || '{}',
    ) as Record<string, unknown>;
    const trusted: Record<string, true> = {};
    for (const [key, value] of Object.entries(parsed ?? {})) {
      if (value === true) trusted[key] = true;
    }
    return trusted;
  } catch {
    return {};
  }
}

const fingerprintCheckCache = new Map<
  string,
  { result: FingerprintCheckResult; timestamp: number }
>();
const fingerprintSaveCache = new Map<string, number>();
const CACHE_TTL_MS = 60_000;

function manualTrustKey(currentUserId: string, peerUserId: string): string {
  return `${currentUserId}:${peerUserId}`;
}

function saveManualTrustContact(currentUserId: string, peerUserId: string): void {
  const trusted = getManuallyTrustedContacts();
  trusted[manualTrustKey(currentUserId, peerUserId)] = true;
  localStorage.setItem(
    MANUAL_TRUST_CONTACTS_KEY,
    hardGlobals.jsonStringify(trusted),
  );
}

function isManuallyTrustedContact(currentUserId: string, peerUserId: string): boolean {
  return getManuallyTrustedContacts()[manualTrustKey(currentUserId, peerUserId)] === true;
}

function isPeerManuallyTrustedOnDevice(peerUserId: string): boolean {
  const suffix = `:${peerUserId}`;
  return Object.keys(getManuallyTrustedContacts()).some((key) => key.endsWith(suffix));
}

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

    if (verifiedByUser) {
      // The user's decision applies to the contact, not only to the current
      // key fingerprint. Persist the policy only after the server confirms it.
      saveKnownFingerprint(peerUserId, fingerprint);
      saveManualTrustContact(userId, peerUserId);
    }

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

  // Once manually trusted, the contact remains trusted across future key
  // rotations. The latest fingerprint is refreshed locally without reopening
  // the warning or blocking the transport.
  if (isManuallyTrustedContact(currentUserId, peerUserId)) {
    if (localPrevious !== currentFingerprint) {
      saveKnownFingerprint(peerUserId, currentFingerprint);
    }
    const result = { changed: false, previousFp: null };
    fingerprintCheckCache.set(cacheKey, { result, timestamp: Date.now() });
    return result;
  }

  const cached = fingerprintCheckCache.get(cacheKey);
  // A previous allow may be reused. A previous block must re-check the server
  // so a manual trust decision made in another tab/device takes effect.
  if (
    cached &&
    !cached.result.changed &&
    Date.now() - cached.timestamp < CACHE_TTL_MS
  ) {
    return cached.result;
  }

  let serverPrevious: string | null = null;
  let serverManuallyTrusted = false;
  try {
    const { data, error } = await supabase
      .from('user_known_fingerprints')
      .select('fingerprint, verified_manually')
      .eq('user_id', currentUserId)
      .eq('peer_user_id', peerUserId)
      .maybeSingle();
    if (error) throw error;
    serverPrevious = data?.fingerprint ?? null;
    serverManuallyTrusted = data?.verified_manually === true;
  } catch {
    // Local trust remains authoritative while the server is temporarily
    // unreachable. A missing local record is first contact, not a rotation.
  }

  if (serverManuallyTrusted) {
    saveManualTrustContact(currentUserId, peerUserId);
    if (localPrevious !== currentFingerprint) {
      saveKnownFingerprint(peerUserId, currentFingerprint);
    }
    const result = { changed: false, previousFp: null };
    fingerprintCheckCache.set(cacheKey, { result, timestamp: Date.now() });
    return result;
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
 * send after an untrusted account identity rotation.
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
    // cached identity must not hide a rotation for contacts not manually trusted.
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
  if (isPeerManuallyTrustedOnDevice(userId)) return false;
  const previousFingerprint = getKnownFingerprints()[userId];
  return Boolean(previousFingerprint && previousFingerprint !== currentFingerprint);
}
