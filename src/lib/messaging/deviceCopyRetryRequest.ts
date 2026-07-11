import { supabase } from '@/integrations/supabase/client';
import { logCryptoError, logCryptoException } from '@/lib/crypto/errorLogger';
import { getCurrentDeviceId, isDeviceIdTemporary } from './currentDevice';

const FIRST_RETRY_COOLDOWN_MS = 3_000;
const REPEAT_COOLDOWN_MS = 30_000;
const SUCCESS_LOG_COOLDOWN_MS = 5 * 60_000;
const RECOVERY_WAKE_DELAYS_MS = [1_500, 4_000, 8_000];
const lastRequestAt = new Map<string, { at: number; count: number }>();
const lastSuccessLogAt = new Map<string, number>();
const recoveryTimers = new Map<string, ReturnType<typeof setTimeout>[]>();

interface RetryRequestInput {
  messageId: string;
  senderUserId: string;
  senderDeviceId?: string | null;
}

function shouldLogSuccess(senderUserId: string, requesterDeviceId: string, now: number): boolean {
  const key = `${senderUserId}:${requesterDeviceId}`;
  const last = lastSuccessLogAt.get(key) ?? 0;
  if (now - last < SUCCESS_LOG_COOLDOWN_MS) return false;
  lastSuccessLogAt.set(key, now);
  return true;
}

function dispatchRecoveryRetry(messageId: string, reason: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
      detail: { messageId, reason },
    }));
  } catch {
    // SSR / hardened webview: no-op.
  }
}

function scheduleRecoveryWakeups(key: string, messageId: string): void {
  const existing = recoveryTimers.get(key) ?? [];
  existing.forEach(clearTimeout);

  const timers = RECOVERY_WAKE_DELAYS_MS.map((delayMs, index) => setTimeout(() => {
    dispatchRecoveryRetry(messageId, `device_copy_retry_wakeup_${index + 1}`);
    if (index === RECOVERY_WAKE_DELAYS_MS.length - 1) recoveryTimers.delete(key);
  }, delayMs));
  recoveryTimers.set(key, timers);
}

export async function requestDeviceCopyRetry(input: RetryRequestInput): Promise<boolean> {
  if (!input.messageId || !input.senderUserId) return false;
  if (isDeviceIdTemporary()) return false;

  const requesterDeviceId = getCurrentDeviceId();
  const key = `${input.messageId}:${input.senderUserId}:${requesterDeviceId}`;
  const now = Date.now();
  const prev = lastRequestAt.get(key);
  const cooldown = (prev?.count ?? 0) === 0 ? FIRST_RETRY_COOLDOWN_MS : REPEAT_COOLDOWN_MS;

  if (prev && now - prev.at < cooldown) {
    logCryptoError({
      severity: 'info',
      context: 'decrypt',
      errorCode: 'DEVICE_COPY_RETRY_THROTTLED',
      errorMessage: 'Device-copy retry request throttled',
      myDeviceId: requesterDeviceId,
      peerUserId: input.senderUserId,
      peerDeviceId: input.senderDeviceId,
      metadata: { messageId: input.messageId.slice(0, 8), cooldownMs: cooldown },
    });
    return false;
  }
  lastRequestAt.set(key, { at: now, count: (prev?.count ?? 0) + 1 });

  try {
    const { data, error } = await (supabase as any).rpc('request_device_copy_retry', {
      p_message_id: input.messageId,
      p_sender_user_id: input.senderUserId,
      p_requester_device_id: requesterDeviceId,
    });

    if (error) {
      logCryptoError({
        severity: 'warning',
        context: 'decrypt',
        errorCode: 'DEVICE_COPY_RETRY_REQUEST_FAILED',
        errorMessage: error.message,
        myDeviceId: requesterDeviceId,
        peerUserId: input.senderUserId,
        peerDeviceId: input.senderDeviceId,
        metadata: { messageId: input.messageId.slice(0, 8) },
      });
      return false;
    }

    const result = data as { ok?: boolean; code?: string } | null;
    if (result?.ok === false && result?.code !== 'RETRY_BUDGET_EXHAUSTED' && result?.code !== 'RETRY_ALREADY_DONE') {
      logCryptoError({
        severity: 'warning',
        context: 'decrypt',
        errorCode: 'DEVICE_COPY_RETRY_REQUEST_FAILED',
        errorMessage: result.code || 'DEVICE_COPY_RETRY_REQUEST_REJECTED',
        myDeviceId: requesterDeviceId,
        peerUserId: input.senderUserId,
        peerDeviceId: input.senderDeviceId,
        metadata: { messageId: input.messageId.slice(0, 8) },
      });
      return false;
    }

    if (result?.code === 'RETRY_BUDGET_EXHAUSTED') {
      logCryptoError({
        severity: 'info',
        context: 'decrypt',
        errorCode: 'RETRY_BUDGET_EXHAUSTED',
        errorMessage: 'Fresh device-copy retry was not queued',
        myDeviceId: requesterDeviceId,
        peerUserId: input.senderUserId,
        peerDeviceId: input.senderDeviceId,
        metadata: { messageId: input.messageId.slice(0, 8) },
      });
      return false;
    }

    // RETRY_ALREADY_DONE can mean the encrypted copy has just appeared. Wake
    // mounted bubbles immediately and probe again instead of keeping them in
    // the 60-second negative cache.
    dispatchRecoveryRetry(input.messageId, result?.code === 'RETRY_ALREADY_DONE' ? 'retry_already_done' : 'retry_queued');
    scheduleRecoveryWakeups(key, input.messageId);

    if (shouldLogSuccess(input.senderUserId, requesterDeviceId, now)) {
      logCryptoError({
        severity: 'info',
        context: 'decrypt',
        errorCode: result?.code === 'RETRY_ALREADY_DONE' ? 'DEVICE_COPY_RETRY_ALREADY_DONE' : 'DEVICE_COPY_RETRY_REQUESTED',
        errorMessage: result?.code === 'RETRY_ALREADY_DONE'
          ? 'Encrypted device-copy retry was already processed; waking decryptors'
          : 'Requested a fresh encrypted device copy from sender',
        myDeviceId: requesterDeviceId,
        peerUserId: input.senderUserId,
        peerDeviceId: input.senderDeviceId,
        metadata: { messageId: input.messageId.slice(0, 8) },
      });
    }
    return true;
  } catch (e) {
    logCryptoException('decrypt', e, {
      severity: 'warning',
      myDeviceId: requesterDeviceId,
      metadata: {
        stage: 'requestDeviceCopyRetry',
        messageId: input.messageId.slice(0, 8),
      },
    });
    return false;
  }
}
