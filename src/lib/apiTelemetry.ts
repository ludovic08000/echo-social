export type ApiSurface = 'feed' | 'media' | 'messaging' | 'marketplace' | 'other';

export const API_PERFORMANCE_EVENT = 'forsure:api-performance';

export function classifyApiSurface(url: string): ApiSurface {
  if (/\/functions\/v1\/(?:feed-api|ml-feed|feed-scoring)(?:[/?]|$)/.test(url)) return 'feed';
  if (/\/functions\/v1\/(?:r2-upload|r2-presign|image-optimize)(?:[/?]|$)/.test(url)) return 'media';
  if (/\/(?:v1\/rpc\/aegis_|functions\/v1\/(?:sealed-relay|sealed-mint-token|device-link))(?:[^?]*)(?:\?|$)/.test(url)) return 'messaging';
  if (/\/functions\/v1\/(?:marketplace-checkout|mondial-relay|verify-packing-video)(?:[/?]|$)/.test(url)) return 'marketplace';
  return 'other';
}

export function emitApiPerformance(
  url: string,
  response: Response | null,
  startedAt: number,
  transport: 'fetch' | 'xhr',
  networkError = false,
) {
  if (typeof window === 'undefined') return;
  const surface = classifyApiSurface(url);
  if (surface === 'other') return;
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
  const requestId = response?.headers.get('x-request-id') ?? null;
  const serverTiming = response?.headers.get('server-timing') ?? null;
  window.dispatchEvent(new CustomEvent(API_PERFORMANCE_EVENT, { detail: {
    surface,
    duration_ms: durationMs,
    status: response?.status ?? 0,
    ok: response?.ok ?? false,
    network_error: networkError,
    transport,
    request_id: requestId,
    server_timing: serverTiming,
  } }));
}
