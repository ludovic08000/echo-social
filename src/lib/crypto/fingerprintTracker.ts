/**
 * Fingerprint tracker — extracted from useE2EE.ts.
 *
 * Local (localStorage) + server (`user_known_fingerprints`) tracking with a
 * 60s cache to avoid request storms. Implements silent trust-on-first-rotation
 * for benign rotations (peer reinstall) and a hard "changed" return when a
 * previously user-acknowledged fingerprint flips.
 */

import { supabase } from '@/integrations/supabase/client';
import { hardGlobals } from './cryptoIntegrity';
import { getCachedAuthUserId } from './peerKeyCache';

export const KNOWN_FP_KEY = 'forsure-known-fps';

export type FingerprintCheckResult = { changed: boolean; previousFp: string | null };

export function getKnownFingerprints(): Record<string, string> {
  try {
    return hardGlobals.jsonParse(localStorage.getItem(KNOWN_FP_KEY) || '{}');
  } catch {
    return {};
  }
}

export function saveKnownFingerprint(userId: string, fp: string): void {
  const known = getKnownFingerprints();
  known[userId] = fp;
  localStorage.setItem(KNOWN_FP_KEY, hardGlobals.jsonStringify(known));
}

const _fpCheckCache = new Map<string, { result: FingerprintCheckResult; ts: number }>();

export function invalidateFingerprintCheckCache(peerUserId: string): void {
  for (const key of _fpCheckCache.keys()) {
    if (key.includes(`:${peerUserId}:`)) _fpCheckCache.delete(key);
  }
}

const _fpSaveCache = new Map<string, number>();

/** Save fingerprint to server for cross-device verification (deduplicated). */
export async function saveKnownFingerprintServer(
  peerUserId: string,
  fp: string,
  force = false,
): Promise<void> {
  const cacheKey = `${peerUserId}:${fp}`;
  const lastSaved = _fpSaveCache.get(cacheKey);
  if (!force && lastSaved && Date.now() - lastSaved < 60_000) return;
  _fpSaveCache.set(cacheKey, Date.now());

  try {
    const userId = await getCachedAuthUserId();
    if (!userId) return;
    await supabase
      .from('user_known_fingerprints')
      .upsert(
        {
          user_id: userId,
          peer_user_id: peerUserId,
          fingerprint: fp,
          last_seen_at: new Date().toISOString(),
          acknowledged: true,
        },
        { onConflict: 'user_id,peer_user_id' },
      );
    invalidateFingerprintCheckCache(peerUserId);
  } catch (e) {
    console.warn('[E2EE] Server fingerprint save failed:', e);
  }
}

/** Check fingerprint against both local AND server records (with cache). */
export async function checkFingerprintChangeWithServer(
  currentUserId: string,
  peerUserId: string,
  currentFp: string,
): Promise<FingerprintCheckResult> {
  const known = getKnownFingerprints();
  const localPrevious = known[peerUserId];

  const cacheKey = `${currentUserId}:${peerUserId}:${currentFp}`;
  const cached = _fpCheckCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 60_000) return cached.result;

  try {
    const { data } = await supabase
      .from('user_known_fingerprints')
      .select('fingerprint, acknowledged')
      .eq('user_id', currentUserId)
      .eq('peer_user_id', peerUserId)
      .maybeSingle();

    if (data && data.fingerprint !== currentFp) {
      // Silent trust-on-first-rotation when not user-verified.
      if (!data.acknowledged) {
        console.warn('[PEER_KEY] 🔄 Server fingerprint rotated for', peerUserId, '— auto-trusting (was never user-verified)');
        try {
          const userId = await getCachedAuthUserId();
          if (userId) {
            await supabase
              .from('user_known_fingerprints')
              .upsert(
                {
                  user_id: userId,
                  peer_user_id: peerUserId,
                  fingerprint: currentFp,
                  last_seen_at: new Date().toISOString(),
                  acknowledged: false,
                },
                { onConflict: 'user_id,peer_user_id' },
              );
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
      try {
        const [{ recordIdentityChange }, { peerHasRecentRecoveryMarker }] = await Promise.all([
          import('@/lib/crypto/identityChangeLedger'),
          import('@/lib/crypto/recoveryMarkers'),
        ]);
        const isRecovery = await peerHasRecentRecoveryMarker(peerUserId, currentFp);
        await recordIdentityChange({
          observerUserId: currentUserId,
          peerUserId,
          previousFingerprint: data.fingerprint,
          newFingerprint: currentFp,
          changeType: isRecovery ? 'recovery_restore' : 'identity_rotation',
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
  } catch {}

  if (localPrevious && localPrevious !== currentFp) {
    return { changed: true, previousFp: localPrevious };
  }

  const result = { changed: false, previousFp: null };
  _fpCheckCache.set(cacheKey, { result, ts: Date.now() });
  return result;
}

export function checkFingerprintChange(userId: string, currentFp: string): boolean {
  const known = getKnownFingerprints();
  const previousFp = known[userId];
  if (previousFp && previousFp !== currentFp) {
    console.warn('[PEER_KEY] ⚠️ fingerprint changed for', userId);
    return true;
  }
  return false;
}
