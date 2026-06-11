import { supabase } from '@/integrations/supabase/client';
import { logCryptoError, logCryptoException } from '@/lib/crypto/errorLogger';
import { getCurrentDeviceId, isDeviceIdTemporary } from './currentDevice';

const REQUEST_COOLDOWN_MS = 30_000;
const lastRequestAt = new Map<string, number>();

interface RetryRequestInput {
  messageId: string;
  senderUserId: string;
  senderDeviceId?: string | null;
}

export async function requestDeviceCopyRetry(input: RetryRequestInput): Promise<boolean> {
  if (!input.messageId || !input.senderUserId) return false;
  if (isDeviceIdTemporary()) return false;

  const requesterDeviceId = getCurrentDeviceId();
  const key = `${input.messageId}:${input.senderUserId}:${requesterDeviceId}`;
  const now = Date.now();
  const last = lastRequestAt.get(key) ?? 0;
  if (now - last < REQUEST_COOLDOWN_MS) return false;
  lastRequestAt.set(key, now);

  try {
    const { data, error } = await (supabase as any).rpc("request_device_copy_retry", {
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
        metadata: { messageId: input.messageId, senderUserId: input.senderUserId, senderDeviceId: input.senderDeviceId },
      });
      return false;
    }

    const result = data as { ok?: boolean; code?: string } | null;
    if (result?.ok === false || result?.code === 'RETRY_BUDGET_EXHAUSTED' || result?.code === 'RETRY_ALREADY_DONE') {
      logCryptoError({
        severity: 'info',
        context: 'decrypt',
        errorCode: result.code || 'DEVICE_COPY_RETRY_NOT_QUEUED',
        errorMessage: 'Fresh device-copy retry was not queued',
        myDeviceId: requesterDeviceId,
        peerUserId: input.senderUserId,
        peerDeviceId: input.senderDeviceId,
        metadata: { messageId: input.messageId, senderUserId: input.senderUserId, senderDeviceId: input.senderDeviceId },
      });
      return false;
    }

    logCryptoError({
      severity: 'info',
      context: 'decrypt',
      errorCode: 'DEVICE_COPY_RETRY_REQUESTED',
      errorMessage: 'Requested a fresh encrypted device copy from sender',
      myDeviceId: requesterDeviceId,
      peerUserId: input.senderUserId,
      peerDeviceId: input.senderDeviceId,
      metadata: { messageId: input.messageId, senderUserId: input.senderUserId, senderDeviceId: input.senderDeviceId },
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
