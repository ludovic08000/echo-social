import { supabase } from '@/integrations/supabase/client';

type TokenResult = { token: string; url: string; role: 'viewer' | 'host' | 'moderator' };

/**
 * In-memory token cache (per room). LiveKit access tokens have a default
 * 6h TTL; we cache for 4 minutes to stay well within that window while
 * eliminating round-trips when the user swipes between lives.
 */
const tokenCache = new Map<string, { value: TokenResult; expires: number }>();
const inflight = new Map<string, Promise<TokenResult>>();
const CACHE_TTL_MS = 4 * 60_000;

async function fetchToken(roomName: string, refresh: boolean): Promise<TokenResult> {
  if (refresh) {
    const { error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError) {
      const { data: { session: existing } } = await supabase.auth.getSession();
      if (!existing) throw new Error('Not authenticated');
    }
  }

  const { data, error } = await supabase.functions.invoke('livekit-token', {
    body: { roomName },
  });
  if (error) throw error;
  return data as TokenResult;
}

export async function getLiveKitToken(roomName: string, _isHost?: boolean) {
  const cached = tokenCache.get(roomName);
  if (cached && cached.expires > Date.now()) return cached.value;

  const existing = inflight.get(roomName);
  if (existing) return existing;

  const p = fetchToken(roomName, true).then(value => {
    tokenCache.set(roomName, { value, expires: Date.now() + CACHE_TTL_MS });
    inflight.delete(roomName);
    return value;
  }).catch(err => {
    inflight.delete(roomName);
    throw err;
  });
  inflight.set(roomName, p);
  return p;
}

/**
 * Fire-and-forget prefetch — call when a tile becomes visible / on hover.
 * Skips the auth.refreshSession() round-trip to stay snappy.
 */
export function prefetchLiveKitToken(roomName: string): void {
  if (!roomName) return;
  const cached = tokenCache.get(roomName);
  if (cached && cached.expires > Date.now()) return;
  if (inflight.has(roomName)) return;

  const p = fetchToken(roomName, false).then(value => {
    tokenCache.set(roomName, { value, expires: Date.now() + CACHE_TTL_MS });
    inflight.delete(roomName);
    return value;
  }).catch(err => {
    inflight.delete(roomName);
    throw err;
  });
  inflight.set(roomName, p);
  // Swallow errors silently — this is a best-effort warm-up
  p.catch(() => {});
}
