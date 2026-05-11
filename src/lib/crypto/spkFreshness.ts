/**
 * Peer SPK freshness probe — extracted from useE2EE.ts.
 *
 * Throttled (30s/peer) check that returns true when the local cached
 * lastUsedSpkId no longer matches the active SPK on the server, so the caller
 * can purge the local ratchet and re-handshake against the fresh bundle.
 */

import { supabase } from '@/integrations/supabase/client';

const _spkCheckCache = new Map<string, number>();
const SPK_CHECK_TTL = 30_000;

export async function isPeerSPKStale(
  peerUserId: string,
  lastUsedSpkId: number | undefined,
): Promise<boolean> {
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
      console.warn(
        `[E2EE] ⚠️ SPK du pair ${peerUserId} a changé (local=#${lastUsedSpkId} → serveur=#${currentSpkId}) — re-handshake requis`,
      );
      return true;
    }
    return false;
  } catch (e) {
    console.warn('[E2EE] isPeerSPKStale check failed:', e);
    return false;
  }
}
