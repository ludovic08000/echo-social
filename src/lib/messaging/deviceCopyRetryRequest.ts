import { supabase } from '@/integrations/supabase/client';
import { logCryptoError, logCryptoException } from '@/lib/crypto/errorLogger';
import { getCurrentDeviceId, isDeviceIdTemporary } from './currentDevice';

const REQUEST_COOLDOWN_MS = 30_000;
const MAX_REQUESTS_PER_SESSION = 2;
const lastRequestAt = new Map<string, number>();
const requestCount = new Map<string, number>();
const stoppedLogged = new Set<string>();

interface RetryRequestInput {
  messageId: string;
  senderUserId: string;
}

export async function requestDeviceCopyRetry(input: RetryRequestInput): Promise<boolean> {
  if (!input.messageId || !input.senderUserId) return false;
  if (isDeviceIdTemporary()) return false;

  const requesterDeviceId = getCurrentDeviceId();
  const key = `${input.messageId}:${input.senderUserId}:${requesterDeviceId}`;
  const now = Date.now();
  const last = lastRequestAt.get(key) ?? 0;
  if (now - last < REQUEST_COOLDOWN_MS) return false;
  const count = requestCount.get(key) ?? 0;
  if (count >= MAX_REQUESTS_PER_SESSION) {
    if (!stoppedLogged.has(key)) {
      stoppedLogged.add(key);
      logCryptoError({
        severity: 'info',
        context: 'decrypt',
        errorCode: 'DEVICE_COPY_RETRY_STOPPED',
        errorMessage: 'Device-copy retry request budget exhausted for this session',
        myDeviceId: requesterDeviceId,
        metadata: { messageId: input.messageId, senderUserId: input.senderUserId, attempts: count },
      });
    }
    return false;
  }
  lastRequestAt.set(key, now);
  requestCount.set(key, count + 1);

  try {
    const { error } = await supabase.rpc('request_device_copy_retry', {
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
        metadata: { messageId: input.messageId, senderUserId: input.senderUserId },
      });
      return false;
    }

    logCryptoError({
      severity: 'info',
      context: 'decrypt',
      errorCode: 'DEVICE_COPY_RETRY_REQUESTED',
      errorMessage: 'Requested a fresh encrypted device copy from sender',
      myDeviceId: requesterDeviceId,
      metadata: { messageId: input.messageId, senderUserId: input.senderUserId },
    });
    return true;
  } catch (e) {
    logCryptoException('decrypt', e, {
      severity: 'warning',
      myDeviceId: requesterDeviceId,
      metadata: {
        stage: 'requestDeviceCopyRetry',
        messageId: input.messageId,
        senderUserId: input.senderUserId,
      },
    });
    return false;
  }
}
