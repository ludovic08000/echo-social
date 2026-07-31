/**
 * Privacy-bounded crypto diagnostics.
 *
 * Raw exception messages, stacks, identifiers, plaintext, ciphertext, URLs,
 * tokens and key material are never persisted or mirrored to the console.
 */

import { supabase } from '@/integrations/supabase/client';

export type CryptoErrorSeverity = 'info' | 'warning' | 'error' | 'critical';

export type CryptoErrorContext =
  | 'encrypt'
  | 'decrypt'
  | 'handshake'
  | 'fanout'
  | 'queue.encrypt'
  | 'queue.send'
  | 'queue.trace'
  | 'queue.handler_missing'
  | 'session.invalidate'
  | 'session.establish'
  | 'key.rotate'
  | 'key.fetch'
  | 'backup'
  | 'restore'
  | 'media'
  | 'unknown';

export interface CryptoErrorEntry {
  severity: CryptoErrorSeverity;
  context: CryptoErrorContext;
  errorCode: string;
  errorMessage: string;
  conversationId?: string | null;
  myDeviceId?: string | null;
  peerUserId?: string | null;
  peerDeviceId?: string | null;
  stack?: string | null;
  metadata?: Record<string, unknown> | null;
}

type BufferedEntry = CryptoErrorEntry & { ts: string };

const BUFFER: BufferedEntry[] = [];
const MAX_BUFFER = 20;
const FLUSH_INTERVAL_MS = 2_000;
const SAFE_TOKEN = /^[A-Za-z0-9_.:/-]{1,96}$/;
const FORBIDDEN_KEY = /(plain|body|content|cipher|secret|token|key|url|email|phone|user|device|peer|conversation|message|archive|payload|session|trace|localid)/i;
const SAFE_STRING_KEY = /^(stage|action|status|kind|reason|context|mimeType|platform|transport|errorCode)$/;
const SAFE_NUMBER_KEY = /(count|size|bytes|length|duration|elapsed|retry|attempt|index|version|status)$/i;
const SAFE_BOOLEAN_KEY = /(active|enabled|verified|encrypted|ready|resumed|available|success|video)$/i;

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

function isDev(): boolean {
  try {
    return import.meta.env?.DEV === true;
  } catch {
    return false;
  }
}

function safeCode(value: unknown): string {
  return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : 'E_UNKNOWN';
}

function genericMessage(code: string): string {
  return `CRYPTO_DIAGNOSTIC_${safeCode(code)}`;
}

export function sanitizeCryptoMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata) return null;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (FORBIDDEN_KEY.test(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value) && SAFE_NUMBER_KEY.test(key)) {
      safe[key] = value;
      continue;
    }
    if (typeof value === 'boolean' && SAFE_BOOLEAN_KEY.test(key)) {
      safe[key] = value;
      continue;
    }
    if (typeof value === 'string' && SAFE_STRING_KEY.test(key) && SAFE_TOKEN.test(value)) {
      safe[key] = value;
    }
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

/** Inspect locally only to derive a bounded code; never return raw text or stack. */
export function classifyCryptoError(err: unknown): { code: string; message: string; stack?: string } {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  let code = 'E_UNKNOWN';
  if (/not active/i.test(msg)) code = 'E_NOT_ACTIVE';
  else if (/initializ/i.test(msg)) code = 'E_INITIALIZING';
  else if (/no session/i.test(msg) || /session.*not.*found/i.test(msg)) code = 'E_NO_SESSION';
  else if (/handler.*missing/i.test(msg)) code = 'E_NO_HANDLER';
  else if (/x3dh/i.test(msg)) code = 'E_X3DH';
  else if (/ratchet/i.test(msg)) code = 'E_RATCHET';
  else if (/decrypt/i.test(msg)) code = 'E_DECRYPT';
  else if (/encrypt/i.test(msg)) code = 'E_ENCRYPT';
  else if (/key/i.test(msg)) code = 'E_KEY';
  else if (/network|fetch|503|502|429|timeout/i.test(msg)) code = 'E_NETWORK';
  return { code, message: genericMessage(code) };
}

function sanitizeEntry(entry: CryptoErrorEntry): CryptoErrorEntry {
  const code = safeCode(entry.errorCode);
  return {
    severity: entry.severity,
    context: entry.context,
    errorCode: code,
    errorMessage: genericMessage(code),
    conversationId: null,
    myDeviceId: null,
    peerUserId: null,
    peerDeviceId: null,
    stack: null,
    metadata: sanitizeCryptoMetadata(entry.metadata),
  };
}

async function flushNow(): Promise<void> {
  if (flushing || BUFFER.length === 0) return;
  flushing = true;
  const batch = BUFFER.splice(0, BUFFER.length);
  try {
    const { data: sess } = await supabase.auth.getSession();
    const userId = sess.session?.user?.id;
    if (!userId) return;
    const rows = batch.map((entry) => ({
      user_id: userId,
      severity: entry.severity,
      context: entry.context,
      error_code: entry.errorCode,
      error_message: entry.errorMessage,
      conversation_id: null,
      my_device_id: null,
      peer_user_id: null,
      peer_device_id: null,
      stack: null,
      user_agent: null,
      metadata: (entry.metadata ?? null) as never,
      created_at: entry.ts,
    }));
    const { error } = await supabase.from('crypto_error_logs').insert(rows);
    if (error && BUFFER.length < MAX_BUFFER * 2) BUFFER.unshift(...batch);
  } catch {
    if (BUFFER.length < MAX_BUFFER * 2) BUFFER.unshift(...batch);
  } finally {
    flushing = false;
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushNow();
  }, FLUSH_INTERVAL_MS);
}

export function logCryptoError(entry: CryptoErrorEntry): void {
  try {
    const sanitized = sanitizeEntry(entry);
    BUFFER.push({ ...sanitized, ts: new Date().toISOString() });
    if (isDev()) {
      console.warn(
        `[CRYPTO ${sanitized.severity.toUpperCase()}][${sanitized.context}] ${sanitized.errorCode}`,
        sanitized.metadata ?? {},
      );
    }
    if (BUFFER.length >= MAX_BUFFER) void flushNow();
    else scheduleFlush();
  } catch {
    // Diagnostics must never alter cryptographic control flow.
  }
}

export function logCryptoException(
  context: CryptoErrorContext,
  err: unknown,
  extra: Omit<CryptoErrorEntry, 'severity' | 'context' | 'errorCode' | 'errorMessage' | 'stack'> & {
    severity?: CryptoErrorSeverity;
  } = {},
): void {
  const classified = classifyCryptoError(err);
  logCryptoError({
    severity: extra.severity ?? 'error',
    context,
    errorCode: classified.code,
    errorMessage: classified.message,
    conversationId: extra.conversationId,
    myDeviceId: extra.myDeviceId,
    peerUserId: extra.peerUserId,
    peerDeviceId: extra.peerDeviceId,
    metadata: extra.metadata,
  });
}

export async function flushCryptoErrors(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushNow();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => void flushNow());
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushNow();
  });
}

export const __test__ = { sanitizeEntry, safeCode, genericMessage };
