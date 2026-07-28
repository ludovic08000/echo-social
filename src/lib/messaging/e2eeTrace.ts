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
const events: E2EETraceEvent[] = [];

/** Metadata only: callers must never include plaintext, ciphertext or keys. */
export function traceE2EE(
  event: Omit<E2EETraceEvent, 'at'>,
  level: 'info' | 'warn' | 'error' = 'info',
): void {
  const record: E2EETraceEvent = { at: new Date().toISOString(), ...event };
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
