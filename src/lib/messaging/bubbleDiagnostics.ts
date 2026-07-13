export type BubbleDiagnosticStage =
  | 'OUTBOX_PUT'
  | 'OUTBOX_DELETE'
  | 'OUTBOX_RESTORE'
  | 'MERGE_START'
  | 'MERGE_RESULT'
  | 'OPTIMISTIC_ACK_MATCH'
  | 'OPTIMISTIC_RETAINED'
  | 'MESSAGE_ADDED'
  | 'MESSAGE_REMOVED'
  | 'MESSAGE_REORDERED'
  | 'BUBBLE_MOUNT'
  | 'BUBBLE_UNMOUNT'
  | 'DECRYPT_START'
  | 'DECRYPT_SUCCESS'
  | 'DECRYPT_STICKY'
  | 'DECRYPT_PENDING'
  | 'DECRYPT_FAILED'
  | 'MEDIA_STATE'
  | 'REALTIME_EVENT'
  | 'UNKNOWN';

export interface BubbleDiagnosticEvent {
  seq: number;
  at: string;
  elapsedMs: number;
  stage: BubbleDiagnosticStage;
  conversationId?: string;
  messageId?: string;
  localId?: string;
  serverId?: string | null;
  traceId?: string;
  reason?: string;
  details?: Record<string, unknown>;
}

const STORAGE_KEY = 'forsureBubbleDebug';
const SESSION_KEY = 'forsureBubbleDebugSession';
const MAX_EVENTS = 1500;
const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
let sequence = 0;
const events: BubbleDiagnosticEvent[] = [];

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

/** Enabled by default while the bubble incident is under investigation. */
export function isBubbleDebugEnabled(): boolean {
  if (!isBrowser()) return false;
  return localStorage.getItem(STORAGE_KEY) !== 'off';
}

export function setBubbleDebugEnabled(enabled: boolean): void {
  if (!isBrowser()) return;
  localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
}

function sanitizeDetails(details?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    const lower = key.toLowerCase();
    if (
      lower.includes('plaintext') ||
      lower === 'body' ||
      lower.includes('ciphertext') ||
      lower.includes('encryptedbody') ||
      lower.includes('archivebody') ||
      lower.includes('keyb64')
    ) {
      if (typeof value === 'string') safe[`${key}Length`] = value.length;
      continue;
    }
    if (typeof value === 'string') safe[key] = value.length > 180 ? `${value.slice(0, 177)}…` : value;
    else if (Array.isArray(value)) safe[key] = value.slice(0, 30);
    else safe[key] = value;
  }
  return safe;
}

export function bubbleDiagnostic(
  stage: BubbleDiagnosticStage,
  event: Omit<BubbleDiagnosticEvent, 'seq' | 'at' | 'elapsedMs' | 'stage'> = {},
): void {
  if (!isBubbleDebugEnabled()) return;

  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const entry: BubbleDiagnosticEvent = {
    seq: ++sequence,
    at: new Date().toISOString(),
    elapsedMs: Math.round(now - startedAt),
    stage,
    ...event,
    details: sanitizeDetails(event.details),
  };
  events.push(entry);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);

  const label = `[BUBBLE:${stage}]`;
  if (stage === 'MESSAGE_REMOVED' || stage === 'BUBBLE_UNMOUNT' || stage === 'DECRYPT_FAILED') {
    console.warn(label, entry);
  } else {
    console.info(label, entry);
  }
}

export function getBubbleDiagnostics(): BubbleDiagnosticEvent[] {
  return events.map((event) => ({ ...event, details: event.details ? { ...event.details } : undefined }));
}

export function clearBubbleDiagnostics(): void {
  events.length = 0;
  sequence = 0;
}

export function exportBubbleDiagnostics(): string {
  const payload = {
    exportedAt: new Date().toISOString(),
    session: isBrowser() ? sessionStorage.getItem(SESSION_KEY) : null,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    events: getBubbleDiagnostics(),
  };
  return JSON.stringify(payload, null, 2);
}

export async function copyBubbleDiagnostics(): Promise<string> {
  const text = exportBubbleDiagnostics();
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  }
  return text;
}

if (isBrowser()) {
  if (!sessionStorage.getItem(SESSION_KEY)) {
    sessionStorage.setItem(SESSION_KEY, crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
  }

  const api = {
    enable: () => setBubbleDebugEnabled(true),
    disable: () => setBubbleDebugEnabled(false),
    clear: clearBubbleDiagnostics,
    get: getBubbleDiagnostics,
    export: exportBubbleDiagnostics,
    copy: copyBubbleDiagnostics,
  };

  (window as Window & { __FORSURE_BUBBLE_DEBUG__?: typeof api }).__FORSURE_BUBBLE_DEBUG__ = api;
}
