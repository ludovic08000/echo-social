import { supabase } from '@/integrations/supabase/client';
import {
  AegisCallError,
  callErrorFromServer,
  normalizeAegisCallError,
  traceCall,
} from '@/lib/calls/callDiagnostics';

type TokenResult = { token: string; url: string; role: 'viewer' | 'host' | 'moderator' };

const tokenCache = new Map<string, { value: TokenResult; expires: number }>();
const inflight = new Map<string, Promise<TokenResult>>();
const CACHE_TTL_MS = 4 * 60_000;
const TOKEN_TIMEOUT_MS = 15_000;

type FunctionInvokeError = Error & { context?: Response };

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new AegisCallError('CALL_TOKEN_TIMEOUT')), timeoutMs);
    operation.then(
      (value) => { globalThis.clearTimeout(timer); resolve(value); },
      (error) => { globalThis.clearTimeout(timer); reject(error); },
    );
  });
}

function validTokenResult(value: unknown): value is TokenResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<TokenResult>;
  if (typeof result.token !== 'string' || result.token.length < 32 || result.token.length > 16_384) return false;
  if (!['viewer', 'host', 'moderator'].includes(String(result.role))) return false;
  if (typeof result.url !== 'string' || result.url.length > 2048) return false;
  try {
    const url = new URL(result.url);
    return url.protocol === 'wss:' || url.protocol === 'https:' || (
      import.meta.env.DEV && (url.protocol === 'ws:' || url.protocol === 'http:')
    );
  } catch {
    return false;
  }
}

async function normalizeFunctionError(error: unknown): Promise<AegisCallError> {
  const response = (error as FunctionInvokeError | null)?.context;
  if (!(response instanceof Response)) {
    return normalizeAegisCallError(error, 'CALL_TOKEN_REQUEST_FAILED');
  }
  const diagnosticId = response.headers.get('x-aegis-diagnostic-id');
  let serverCode: unknown;
  try {
    const body = await response.clone().json();
    serverCode = body?.error;
  } catch {
    serverCode = undefined;
  }
  if (response.status === 401) serverCode = serverCode ?? 'NOT_AUTHENTICATED';
  if (response.status === 429) serverCode = serverCode ?? 'CALL_RATE_LIMITED';
  if (response.status >= 500) serverCode = serverCode ?? 'CALL_SERVICE_UNAVAILABLE';
  return callErrorFromServer(serverCode, 'CALL_TOKEN_REQUEST_FAILED', diagnosticId, error);
}

function cacheKey(roomName: string, userId: string, deviceId?: string): string {
  return `${userId}::${roomName}::${deviceId ?? 'account'}`;
}

async function currentAuthScope(): Promise<string> {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session?.user?.id) {
    throw new AegisCallError('CALL_NOT_AUTHENTICATED', { cause: error });
  }
  return session.user.id;
}

async function fetchToken(
  roomName: string,
  refresh: boolean,
  deviceId?: string,
  expectedUserId?: string,
): Promise<TokenResult> {
  const startedAt = Date.now();
  const callId = roomName.startsWith('call-') ? roomName.slice(5) : undefined;
  traceCall({ direction: 'local', stage: 'token_request', outcome: 'start', callId, deviceId });
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !session || (expectedUserId && session.user.id !== expectedUserId)) {
    throw new AegisCallError('CALL_NOT_AUTHENTICATED', { cause: sessionError });
  }
  const expiresAtMs = typeof session.expires_at === 'number' ? session.expires_at * 1000 : 0;
  if (refresh && expiresAtMs > 0 && expiresAtMs - Date.now() < 60_000) {
    const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError || !refreshed.session || refreshed.session.user.id !== session.user.id) {
      if (expiresAtMs <= Date.now() + 5_000) {
        throw new AegisCallError('CALL_AUTH_REFRESH_FAILED', { cause: refreshError });
      }
      // The current JWT is still valid: a transient browser lock must not
      // prevent the call while another tab completes the refresh.
    }
  }

  const { data, error } = await supabase.functions.invoke('livekit-token', {
    body: { roomName, ...(deviceId ? { deviceId } : {}) },
  });
  if (error) throw await normalizeFunctionError(error);
  if (!validTokenResult(data)) throw new AegisCallError('CALL_TOKEN_RESPONSE_INVALID');
  traceCall({
    direction: 'local', stage: 'token_request', outcome: 'ok', callId, deviceId,
    elapsedMs: Date.now() - startedAt,
  });
  return data;
}

export async function getLiveKitToken(
  roomName: string,
  _isHost?: boolean,
  deviceId?: string,
): Promise<TokenResult> {
  const userId = await currentAuthScope();
  const key = cacheKey(roomName, userId, deviceId);
  const cached = tokenCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;

  const existing = inflight.get(key);
  if (existing) return existing;

  const pending = withTimeout(fetchToken(roomName, true, deviceId, userId), TOKEN_TIMEOUT_MS)
    .then((value) => {
      tokenCache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
      inflight.delete(key);
      return value;
    })
    .catch((error) => {
      inflight.delete(key);
      const normalized = normalizeAegisCallError(error, 'CALL_TOKEN_REQUEST_FAILED');
      traceCall({
        direction: 'local',
        stage: 'token_request',
        outcome: 'error',
        callId: roomName.startsWith('call-') ? roomName.slice(5) : undefined,
        deviceId,
        errorCode: normalized.code,
        diagnosticId: normalized.diagnosticId,
      });
      throw normalized;
    });
  inflight.set(key, pending);
  return pending;
}

export function prefetchLiveKitToken(roomName: string): void {
  if (!roomName) return;
  void (async () => {
    const userId = await currentAuthScope();
    const key = cacheKey(roomName, userId);
    const cached = tokenCache.get(key);
    if (cached && cached.expires > Date.now()) return;
    if (inflight.has(key)) return;

    const pending = withTimeout(fetchToken(roomName, false, undefined, userId), TOKEN_TIMEOUT_MS)
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
    await pending;
  })().catch(() => undefined);
}
