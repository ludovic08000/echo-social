/**
 * Peer public key cache + auth user ID cache — extracted from useE2EE.ts.
 *
 * Module-level Maps deduplicate request storms when multiple chat surfaces
 * (ChatView + ChatWidget) mount and call ensureKeysAndPeerSync simultaneously.
 */

import { supabase } from '@/integrations/supabase/client';

export type PeerPublicKeys = {
  identity_key: string;
  signing_key: string;
  fingerprint: string;
};

/** Deduplication lock for ensureKeysAndPeerSync (shared with useE2EE). */
export const _peerSyncPromise = new Map<string, Promise<unknown>>();

/** Global cache for peer public keys — prevents repeated fetches. */
export const _peerKeyCache = new Map<string, { data: PeerPublicKeys | null; ts: number }>();

const PEER_KEY_TTL = 120_000; // 2 min

let _cachedAuthUserId: string | null = null;
let _cachedAuthUserIdTs = 0;
const AUTH_USER_CACHE_TTL = 300_000; // 5 min

export async function getCachedAuthUserId(): Promise<string | null> {
  if (_cachedAuthUserId && Date.now() - _cachedAuthUserIdTs < AUTH_USER_CACHE_TTL) {
    return _cachedAuthUserId;
  }
  try {
    const { data } = await supabase.auth.getUser();
    _cachedAuthUserId = data.user?.id ?? null;
    _cachedAuthUserIdTs = Date.now();
    return _cachedAuthUserId;
  } catch {
    return _cachedAuthUserId;
  }
}

/** Fetch peer public keys with global dedup + cache. */
export async function fetchPeerPublicKeys(peerUserId: string): Promise<PeerPublicKeys | null> {
  const cached = _peerKeyCache.get(peerUserId);
  if (cached && Date.now() - cached.ts < PEER_KEY_TTL) return cached.data;

  const inflightKey = `fetch:${peerUserId}`;
  const inflight = _peerSyncPromise.get(inflightKey);
  if (inflight) {
    await inflight;
    return _peerKeyCache.get(peerUserId)?.data ?? null;
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
