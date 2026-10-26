import { describe, expect, it, vi } from 'vitest';
import { API_PERFORMANCE_EVENT, classifyApiSurface, emitApiPerformance } from '@/lib/apiTelemetry';

describe('API telemetry', () => {
  it('classifies the four operational API surfaces without inspecting payloads', () => {
    expect(classifyApiSurface('https://x/functions/v1/feed-api')).toBe('feed');
    expect(classifyApiSurface('https://x/functions/v1/r2-upload')).toBe('media');
    expect(classifyApiSurface('https://aegis.forsure.fans/v1/rpc/aegis_send_message')).toBe('messaging');
    expect(classifyApiSurface('https://x/functions/v1/marketplace-checkout')).toBe('marketplace');
    expect(classifyApiSurface('https://x/rest/v1/profiles')).toBe('other');
  });

  it('emits bounded correlation data and no request content', () => {
    const listener = vi.fn();
    window.addEventListener(API_PERFORMANCE_EVENT, listener);
    const response = new Response(null, { status: 201, headers: {
      'x-request-id': 'req-1', 'server-timing': 'total;dur=12',
    } });
    emitApiPerformance('https://x/functions/v1/r2-upload', response, performance.now(), 'fetch');
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
      surface: 'media', status: 201, ok: true, request_id: 'req-1', transport: 'fetch',
    });
    window.removeEventListener(API_PERFORMANCE_EVENT, listener);
  });
});
