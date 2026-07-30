import { supabase } from '@/integrations/supabase/client';

type TokenResult = { token: string; url: string; role: 'viewer' | 'host' | 'moderator' };

const tokenCache = new Map<string, { value: TokenResult; expires: number }>();
const inflight = new Map<string, Promise<TokenResult>>();
const CACHE_TTL_MS = 4 * 60_000;

function cacheKey(roomName: string, deviceId?: string): string {
  return `${roomName}::${deviceId ?? 'account'}`;
}

async function fetchToken(
  roomName: string,
  refresh: boolean,
  deviceId?: string,
): Promise<TokenResult> {
  if (refresh) {
    const { error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError) {
      const { data: { session: existing } } = await supabase.auth.getSession();
      if (!existing) throw new Error('Not authenticated');
    }
  }

  const { data, error } = await supabase.functions.invoke('livekit-token', {
    body: { roomName, ...(deviceId ? { deviceId } : {}) },
  });
  if (error) throw error;
  if (!data?.token || !data?.url) throw new Error('Invalid LiveKit token response');
  return data as TokenResult;
}

export async function getLiveKitToken(
  roomName: string,
  _isHost?: boolean,
  deviceId?: string,
): Promise<TokenResult> {
  const key = cacheKey(roomName, deviceId);
  const cached = tokenCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;

  const existing = inflight.get(key);
  if (existing) return existing;

  const pending = fetchToken(roomName, true, deviceId)
    .then((value) => {
      tokenCache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
      inflight.delete(key);
      return value;
    })
    .catch((error) => {
      inflight.delete(key);
      throw error;
    });
  inflight.set(key, pending);
  return pending;
}

export function prefetchLiveKitToken(roomName: string): void {
  if (!roomName) return;
  const key = cacheKey(roomName);
  const cached = tokenCache.get(key);
  if (cached && cached.expires > Date.now()) return;
  if (inflight.has(key)) return;

  const pending = fetchToken(roomName, false)
    .then((value) => {
      tokenCache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
      inflight.delete(key);
      return value;
    })
    .catch((error) => {
      inflight.delete(key);
      throw error;
    });
  inflight.set(key, pending);
  pending.catch(() => undefined);
}
