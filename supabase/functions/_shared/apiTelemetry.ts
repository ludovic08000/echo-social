type TelemetryValue = string | number | boolean | null;

const SAFE_TOKEN = /^[A-Za-z0-9._:-]{1,128}$/;

function safeToken(value: string | null | undefined, fallback: string): string {
  const candidate = value?.trim() ?? '';
  return SAFE_TOKEN.test(candidate) ? candidate : fallback;
}

function roundedDuration(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}

/**
 * Bounded, content-free API telemetry. Never pass message bodies, object paths,
 * email addresses, keys, tokens or user supplied text in dimensions.
 */
export function createApiTelemetry(
  req: Request,
  service: 'feed' | 'media' | 'marketplace',
  logger: (record: Record<string, unknown>) => void = (record) => console.log(JSON.stringify(record)),
) {
  const startedAt = performance.now();
  const requestId = safeToken(req.headers.get('x-request-id'), crypto.randomUUID());
  let operation = req.method.toLowerCase();
  let stage = 'request';
  let finished = false;

  return {
    requestId,
    operation(value: string | null | undefined) {
      operation = safeToken(value, operation);
    },
    stage(value: string) {
      stage = safeToken(value, stage);
    },
    finish(response: Response, dimensions: Record<string, TelemetryValue> = {}, errorCode?: string) {
      if (finished) return response;
      finished = true;
      const durationMs = roundedDuration(startedAt);
      const status = response.status;
      const record = {
        timestamp: new Date().toISOString(),
        event: 'api_request',
        service,
        operation,
        request_id: requestId,
        status,
        outcome: status >= 400 ? 'failure' : 'success',
        duration_ms: durationMs,
        failed_stage: status >= 400 ? stage : null,
        error_code: status >= 400 ? safeToken(errorCode, `HTTP_${status}`) : null,
        ...dimensions,
      };
      try { logger(record); } catch { /* Telemetry never changes business behavior. */ }

      const headers = new Headers(response.headers);
      headers.set('X-Request-ID', requestId);
      headers.set('Server-Timing', `total;dur=${durationMs}`);
      return new Response(response.body, { status, statusText: response.statusText, headers });
    },
  };
}
