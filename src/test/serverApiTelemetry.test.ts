import { describe, expect, it, vi } from 'vitest';
import { createApiTelemetry } from '../../supabase/functions/_shared/apiTelemetry';

describe('server API telemetry', () => {
  it('adds correlation and timing headers while logging bounded metrics', async () => {
    const logger = vi.fn();
    const telemetry = createApiTelemetry(new Request('https://example.test/functions/v1/feed-api', {
      method: 'POST', headers: { 'x-request-id': 'req-safe-1' },
    }), 'feed', logger);
    telemetry.operation('page');
    telemetry.stage('database');
    const response = telemetry.finish(new Response('{}', { status: 503 }), { item_count: 0 }, 'FEED_UNAVAILABLE');

    expect(response.headers.get('x-request-id')).toBe('req-safe-1');
    expect(response.headers.get('server-timing')).toMatch(/^total;dur=\d/);
    expect(response.headers.get('access-control-expose-headers')).toBe('X-Request-ID, Server-Timing');
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({
      event: 'api_request', service: 'feed', operation: 'page', request_id: 'req-safe-1',
      status: 503, outcome: 'failure', failed_stage: 'database', error_code: 'FEED_UNAVAILABLE',
    }));
  });

  it('preserves existing exposed diagnostic headers', () => {
    const telemetry = createApiTelemetry(new Request('https://example.test'), 'marketplace', vi.fn());
    const response = telemetry.finish(new Response(null, { headers: {
      'Access-Control-Expose-Headers': 'x-aegis-diagnostic-id',
    } }));
    expect(response.headers.get('access-control-expose-headers')).toBe(
      'x-aegis-diagnostic-id, X-Request-ID, Server-Timing',
    );
  });

  it('rejects unsafe caller correlation identifiers', () => {
    const logger = vi.fn();
    const telemetry = createApiTelemetry(new Request('https://example.test', {
      headers: { 'x-request-id': 'contains secret whitespace' },
    }), 'media', logger);
    const response = telemetry.finish(new Response(null, { status: 204 }));
    expect(response.headers.get('x-request-id')).not.toBe('contains secret whitespace');
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});
