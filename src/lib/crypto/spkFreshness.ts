/**
 * Peer SPK freshness probe — extracted from useE2EE.ts.
 *
 * A signed-prekey rotation does not invalidate an already-established Double
 * Ratchet session. The server probe is therefore best-effort and must never sit
 * on the click-to-encrypt path. The first call starts a background refresh and
 * returns the last cached answer immediately; a later call can observe `stale`
 * and let the existing recovery logic re-handshake when appropriate.
 */

import { supabase } from '@/integrations/supabase/client';

interface SPKCacheEntry {
  checkedAt: number;
  stale: boolean;
}

const _spkCheckCache = new Map<string, SPKCacheEntry>();
const _spkCheckPromises = new Map<string, Promise<void>>();
const SPK_CHECK_TTL = 30_000;

function cacheKey(peerUserId: string, lastUsedSpkId: number): string {
  return `${peerUserId}:${lastUsedSpkId}`;
}

function startBackgroundProbe(peerUserId: string, lastUsedSpkId: number): void {
  const key = cacheKey(peerUserId, lastUsedSpkId);
  if (_spkCheckPromises.has(key)) return;

  const promise = (async () => {
    try {
      const { data, error } = await supabase.rpc('get_signed_prekey', { p_user_id: peerUserId });
      if (error || !data || data.length === 0) {
        _spkCheckCache.set(key, { checkedAt: Date.now(), stale: false });
        return;
      }

      const currentSpkId = data[0].spk_id as number;
      const stale = currentSpkId !== lastUsedSpkId;
      _spkCheckCache.set(key, { checkedAt: Date.now(), stale });
      if (stale) {
        console.warn(
          `[E2EE] ⚠️ SPK du pair ${peerUserId} a changé (local=#${lastUsedSpkId} → serveur=#${currentSpkId}) — re-handshake requis`,
        );
      }
    } catch (e) {
      _spkCheckCache.set(key, { checkedAt: Date.now(), stale: false });
      console.warn('[E2EE] isPeerSPKStale background check failed:', e);
    }
  })().finally(() => {
    if (_spkCheckPromises.get(key) === promise) _spkCheckPromises.delete(key);
  });

  _spkCheckPromises.set(key, promise);
}

export async function isPeerSPKStale(
  peerUserId: string,
  lastUsedSpkId: number | undefined,
): Promise<boolean> {
  if (lastUsedSpkId === undefined || lastUsedSpkId === null) return false;

  const key = cacheKey(peerUserId, lastUsedSpkId);
  const cached = _spkCheckCache.get(key);
  const now = Date.now();
  if (cached && now - cached.checkedAt < SPK_CHECK_TTL) return cached.stale;

  // Deliberately do not await Supabase here. Encrypt proceeds with the active
  // ratchet while freshness is refreshed in the background.
  startBackgroundProbe(peerUserId, lastUsedSpkId);
  return cached?.stale ?? false;
}

export const __test__ = {
  reset(): void {
    _spkCheckCache.clear();
    _spkCheckPromises.clear();
  },
};
