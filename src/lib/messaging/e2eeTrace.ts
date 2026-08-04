export type E2EETraceDirection = 'send' | 'receive' | 'device' | 'session';

export interface E2EETraceEvent {
  at: string;
  seq: number;
  direction: E2EETraceDirection;
  stage: string;
  component?: string;
  outcome?: 'start' | 'ok' | 'retry' | 'skip' | 'error';
  traceRef?: string;
  messageRef?: string;
  conversationRef?: string;
  deviceRef?: string;
  peerDeviceRef?: string;
  sessionRef?: string;
  elapsedMs?: number;
  blockMs?: number;
  targetCount?: number;
  copyCount?: number;
  retryCount?: number;
  payloadBytes?: number;
  cache?: 'memory' | 'disk' | 'network' | 'miss';
  transport?: 'supabase' | 'aegis_server' | 'local';
  errorCode?: string;
}

export type E2EETraceInput = Omit<E2EETraceEvent, 'at' | 'seq'> & {
  traceId?: string;
  messageId?: string;
  conversationId?: string;
  deviceId?: string;
  peerDeviceId?: string;
  sessionId?: string;
};

const MAX_EVENTS = 300;
const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,96}$/;
const events: E2EETraceEvent[] = [];
let sequence = 0;
const references = new Map<string, string>();
const referenceCounters = new Map<string, number>();

function safeToken(value: unknown, fallback: string): string {
  return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : fallback;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function localReference(kind: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const key = `${kind}:${value}`;
  const known = references.get(key);
  if (known) return known;
  const next = (referenceCounters.get(kind) ?? 0) + 1;
  referenceCounters.set(kind, next);
  const reference = `${kind}-${String(next).padStart(3, '0')}`;
  references.set(key, reference);
  return reference;
}

function safeErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const explicit = value.toUpperCase().match(/[A-Z][A-Z0-9_]{2,95}/)?.[0];
  return explicit ? safeToken(explicit, 'E_UNKNOWN') : 'E_UNKNOWN';
}

/** Strip every account, conversation, message, device and session identifier. */
export function sanitizeE2EETraceEvent(
  event: E2EETraceInput,
): Omit<E2EETraceEvent, 'at'> {
  const record: Omit<E2EETraceEvent, 'at'> = {
    seq: 0,
    direction: event.direction,
    stage: safeToken(event.stage, 'UNCLASSIFIED'),
  };
  if (event.component) record.component = safeToken(event.component, 'unknown');
  if (event.outcome) record.outcome = event.outcome;
  record.traceRef = localReference('trace', event.traceId);
  record.messageRef = localReference('msg', event.messageId);
  record.conversationRef = localReference('conv', event.conversationId);
  record.deviceRef = localReference('dev', event.deviceId);
  record.peerDeviceRef = localReference('dev', event.peerDeviceId);
  record.sessionRef = localReference('session', event.sessionId);
  const elapsedMs = safeNumber(event.elapsedMs);
  const targetCount = safeNumber(event.targetCount);
  const copyCount = safeNumber(event.copyCount);
  const retryCount = safeNumber(event.retryCount);
  const blockMs = safeNumber(event.blockMs);
  const payloadBytes = safeNumber(event.payloadBytes);
  if (elapsedMs !== undefined) record.elapsedMs = elapsedMs;
  if (targetCount !== undefined) record.targetCount = targetCount;
  if (copyCount !== undefined) record.copyCount = copyCount;
  if (retryCount !== undefined) record.retryCount = retryCount;
  if (blockMs !== undefined) record.blockMs = blockMs;
  if (payloadBytes !== undefined) record.payloadBytes = payloadBytes;
  if (event.cache) record.cache = event.cache;
  if (event.transport) record.transport = event.transport;
  const errorCode = safeErrorCode(event.errorCode);
  if (errorCode) record.errorCode = errorCode;
  for (const key of Object.keys(record) as Array<keyof typeof record>) {
    if (record[key] === undefined) delete record[key];
  }
  return record;
}

/** Metadata-only trace. Identifiers supplied by callers are deliberately dropped. */
export function traceE2EE(
  event: E2EETraceInput,
  level: 'info' | 'warn' | 'error' = 'info',
): void {
  const record: E2EETraceEvent = {
    at: new Date().toISOString(),
    ...sanitizeE2EETraceEvent(event),
    seq: ++sequence,
  };
  events.push(record);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  // En production la console est verrouillée : on écrit via la référence brute
  // capturée avant le lockdown, uniquement si le diagnostic est activé.
  if (isE2EEDebugEnabled()) {
    const parts = [
      `#${record.seq}`,
      record.direction.toUpperCase(),
      record.component ?? '-',
      record.stage,
      record.outcome ? `→ ${record.outcome}` : '',
      record.conversationRef ?? '',
      record.messageRef ?? '',
      record.deviceRef ?? '',
      record.peerDeviceRef ?? '',
      record.targetCount !== undefined ? `targets=${record.targetCount}` : '',
      record.copyCount !== undefined ? `copies=${record.copyCount}` : '',
      record.retryCount !== undefined ? `retry=${record.retryCount}` : '',
      record.blockMs !== undefined ? `${record.blockMs}ms` : record.elapsedMs !== undefined ? `+${record.elapsedMs}ms` : '',
      record.transport ? `via ${record.transport}` : '',
      record.errorCode ? `!${record.errorCode}` : '',
    ].filter(Boolean);
    rawConsoleWrite(
      level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log',
      `%c[AEGIS ROUTE]%c ${parts.join(' ')}`,
      `color:${level === 'error' ? '#ED2939' : level === 'warn' ? '#f59e0b' : '#4ea1ff'};font-weight:700`,
      'color:inherit',
      record,
    );
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
  references.clear();
  referenceCounters.clear();
  sequence = 0;
}

/** Mesure un bloc sans jamais journaliser son contenu ni ses cles. */
export async function traceE2EEBlock<T>(
  event: Omit<E2EETraceInput, 'blockMs' | 'outcome'>,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  traceE2EE({ ...event, outcome: 'start' });
  try {
    const result = await operation();
    traceE2EE({ ...event, outcome: 'ok', blockMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    traceE2EE({
      ...event,
      outcome: 'error',
      blockMs: Date.now() - startedAt,
      errorCode: error instanceof Error ? error.message : String(error),
    }, 'error');
    throw error;
  }
}
