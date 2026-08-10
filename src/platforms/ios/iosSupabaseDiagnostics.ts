import { supabase } from '@/integrations/supabase/client';
import { isIosWebRuntime } from '@/platforms/ios/iosRuntime';

const API_PATH = '/api/ios-diagnostics';
const EVENT_RE = /^ios\.[a-z0-9][a-z0-9._-]{0,95}$/;

type IosDiagnosticSeverity = 'info' | 'warn' | 'error';

type IosDiagnosticMetadata = Record<string, string | number | boolean | null | undefined>;

export interface IosDiagnosticEvent {
  event: string;
  severity?: IosDiagnosticSeverity;
  traceId?: string;
  deviceId?: string | null;
  metadata?: IosDiagnosticMetadata;
}

function randomTraceId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `ios:${crypto.randomUUID()}`;
    }
  } catch {
    // Diagnostic correlation is best-effort only.
  }
  return `ios:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 14)}`;
}

export function createIosDiagnosticTrace(scope = 'flow'): string {
  const safeScope = scope.toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 32) || 'flow';
  return `${safeScope}:${randomTraceId()}`;
}

function errorParts(error: unknown): { errorName: string; errorCode: string; errorMessage: string } {
  const errorName = error instanceof Error && error.name ? error.name.slice(0, 120) : 'Error';
  const errorMessage = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  const separator = errorMessage.indexOf(':');
  const candidate = (separator > 0 ? errorMessage.slice(0, separator) : errorMessage)
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .slice(0, 120);
  return {
    errorName,
    errorCode: candidate || 'IOS_CLIENT_ERROR',
    errorMessage,
  };
}

async function persist(event: IosDiagnosticEvent): Promise<void> {
  if (!isIosWebRuntime() || !EVENT_RE.test(event.event)) return;

  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session?.access_token) return;

  const payload = {
    event: event.event,
    severity: event.severity ?? 'info',
    traceId: event.traceId ?? createIosDiagnosticTrace(event.event),
    deviceId: event.deviceId ?? null,
    clientAt: new Date().toISOString(),
    metadata: {
      ...event.metadata,
      online: typeof navigator !== 'undefined' ? navigator.onLine : undefined,
      visibilityState: typeof document !== 'undefined' ? document.visibilityState : undefined,
    },
  };

  try {
    await fetch(API_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Diagnostics are deliberately fail-open and must never alter iOS crypto/device behavior.
  }
}

export function recordIosDiagnostic(event: IosDiagnosticEvent): void {
  void persist(event).catch(() => undefined);
}

export function recordIosDiagnosticError(args: {
  event: string;
  error: unknown;
  traceId?: string;
  deviceId?: string | null;
  metadata?: IosDiagnosticMetadata;
}): void {
  recordIosDiagnostic({
    event: args.event,
    severity: 'error',
    traceId: args.traceId,
    deviceId: args.deviceId,
    metadata: {
      ...args.metadata,
      ...errorParts(args.error),
    },
  });
}
