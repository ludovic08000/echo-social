/**
 * Crypto Error Logger
 *
 * Centralised, persistent diagnostic trail for every encryption-related
 * failure (handshake, ratchet encrypt/decrypt, fanout, queue handlers,
 * key rotation, etc.).
 *
 * Design:
 *  - Logs are batched in-memory and flushed to `crypto_error_logs` every
 *    2s (or when buffer hits 20 entries). Network failures keep the buffer
 *    around for the next flush — never throws into the crypto path.
 *  - Plaintext is NEVER logged: we only record metadata, error codes and
 *    stack traces.
 *  - In dev, every entry is also mirrored to `console.warn` for fast
 *    feedback.
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

const BUFFER: Array<CryptoErrorEntry & { ts: string }> = [];
const MAX_BUFFER = 20;
const FLUSH_INTERVAL_MS = 2_000;

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

function isDev(): boolean {
  try {
    return import.meta.env?.DEV === true;
  } catch {
    return false;
  }
}

function safeUserAgent(): string | null {
  try {
    return typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 500) : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort error → code normaliser. Keeps codes short and grep-friendly
 * in the admin dashboard.
 */
export function classifyCryptoError(err: unknown): { code: string; message: string; stack?: string } {
  if (err instanceof Error) {
    const msg = err.message || 'unknown';
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
    else if (/network|fetch|503|502|429/i.test(msg)) code = 'E_NETWORK';
    return { code, message: msg.slice(0, 1000), stack: err.stack?.slice(0, 2000) };
  }
  return { code: 'E_UNKNOWN', message: String(err).slice(0, 1000) };
}

async function flushNow(): Promise<void> {
  if (flushing || BUFFER.length === 0) return;
  flushing = true;
  const batch = BUFFER.splice(0, BUFFER.length);
  try {
    const { data: sess } = await supabase.auth.getSession();
    const userId = sess.session?.user?.id;
    if (!userId) {
      // Not authenticated — drop silently (RLS would reject anyway).
      return;
    }
    const ua = safeUserAgent();
    const rows = batch.map(e => ({
      user_id: userId,
      severity: e.severity,
      context: e.context,
      error_code: e.errorCode,
      error_message: e.errorMessage,
      conversation_id: e.conversationId ?? null,
      my_device_id: e.myDeviceId ?? null,
      peer_user_id: e.peerUserId ?? null,
      peer_device_id: e.peerDeviceId ?? null,
      stack: e.stack ?? null,
      user_agent: ua,
      metadata: (e.metadata ?? null) as never,
      created_at: e.ts,
    }));
    const { error } = await supabase.from('crypto_error_logs').insert(rows);
    if (error) {
      // Re-queue for next attempt (cap to MAX_BUFFER * 2 to bound memory)
      if (BUFFER.length < MAX_BUFFER * 2) {
        BUFFER.unshift(...batch);
      }
    }
  } catch {
    if (BUFFER.length < MAX_BUFFER * 2) BUFFER.unshift(...batch);
  } finally {
    flushing = false;
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushNow();
  }, FLUSH_INTERVAL_MS);
}

/**
 * Record a crypto-related incident. Never throws.
 */
export function logCryptoError(entry: CryptoErrorEntry): void {
  try {
    const enriched = { ...entry, ts: new Date().toISOString() };
    BUFFER.push(enriched);
    if (isDev()) {
      // eslint-disable-next-line no-console
      console.warn(
        `[CRYPTO ${entry.severity.toUpperCase()}][${entry.context}] ${entry.errorCode}: ${entry.errorMessage}`,
        {
          conv: entry.conversationId,
          myDev: entry.myDeviceId,
          peer: entry.peerUserId,
          peerDev: entry.peerDeviceId,
          meta: entry.metadata,
        },
      );
    }
    if (BUFFER.length >= MAX_BUFFER) {
      void flushNow();
    } else {
      scheduleFlush();
    }
  } catch {
    /* swallow — logging must never break crypto */
  }
}

/**
 * Convenience wrapper: classify and log an unknown error.
 */
export function logCryptoException(
  context: CryptoErrorContext,
  err: unknown,
  extra: Omit<CryptoErrorEntry, 'severity' | 'context' | 'errorCode' | 'errorMessage' | 'stack'> & {
    severity?: CryptoErrorSeverity;
  } = {},
): void {
  const { code, message, stack } = classifyCryptoError(err);
  logCryptoError({
    severity: extra.severity ?? 'error',
    context,
    errorCode: code,
    errorMessage: message,
    stack,
    conversationId: extra.conversationId,
    myDeviceId: extra.myDeviceId,
    peerUserId: extra.peerUserId,
    peerDeviceId: extra.peerDeviceId,
    metadata: extra.metadata,
  });
}

/** Force a synchronous flush (useful on logout / before unload). */
export async function flushCryptoErrors(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushNow();
}

// Auto-flush on tab close
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    void flushNow();
  });
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushNow();
  });
}
