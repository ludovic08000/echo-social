export type E2EETraceDirection = 'send' | 'receive' | 'device' | 'session';

export interface E2EETraceEvent {
  at: string;
  direction: E2EETraceDirection;
  stage: string;
  traceId?: string;
  messageId?: string;
  conversationId?: string;
  deviceId?: string;
  peerDeviceId?: string;
  sessionId?: string;
  elapsedMs?: number;
  targetCount?: number;
  copyCount?: number;
  retryCount?: number;
  errorCode?: string;
}

const MAX_EVENTS = 300;
const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,96}$/;
const events: E2EETraceEvent[] = [];

function safeToken(value: unknown, fallback: string): string {
  return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : fallback;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/** Strip every account, conversation, message, device and session identifier. */
export function sanitizeE2EETraceEvent(
  event: Omit<E2EETraceEvent, 'at'>,
): Omit<E2EETraceEvent, 'at'> {
  const record: Omit<E2EETraceEvent, 'at'> = {
    direction: event.direction,
    stage: safeToken(event.stage, 'UNCLASSIFIED'),
  };
  const elapsedMs = safeNumber(event.elapsedMs);
  const targetCount = safeNumber(event.targetCount);
  const copyCount = safeNumber(event.copyCount);
  const retryCount = safeNumber(event.retryCount);
  if (elapsedMs !== undefined) record.elapsedMs = elapsedMs;
  if (targetCount !== undefined) record.targetCount = targetCount;
  if (copyCount !== undefined) record.copyCount = copyCount;
  if (retryCount !== undefined) record.retryCount = retryCount;
  if (event.errorCode) record.errorCode = safeToken(event.errorCode, 'E_UNKNOWN');
  return record;
}

/** Metadata-only trace. Identifiers supplied by callers are deliberately dropped. */
export function traceE2EE(
  event: Omit<E2EETraceEvent, 'at'>,
  level: 'info' | 'warn' | 'error' = 'info',
): void {
  const record: E2EETraceEvent = {
    at: new Date().toISOString(),
    ...sanitizeE2EETraceEvent(event),
  };
  events.push(record);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  if (typeof console !== 'undefined') {
    const writer = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
    writer('[E2EE_TRACE]', record);
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('forsure:e2ee-trace'));
  }
}

export function readE2EETrace(): E2EETraceEvent[] {
  return events.map((event) => ({ ...event }));
}

export function clearE2EETrace(): void {
  events.length = 0;
}
