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

export interface MessageRefanoutStatus {
  terminal: boolean;
  status: 'none' | 'pending' | 'completed' | 'failed';
  errorCode?: 'REFANOUT_UNAVAILABLE';
}

async function sendRetryRpc(
  rpcName: 'request_device_copy_retry' | 'request_message_refanout',
  input: RetryRequestInput,
  requesterDeviceId: string,
): Promise<{ ok: boolean; missingRpc: boolean; message?: string }> {
  const { error } = await supabase.rpc(rpcName, {
    p_message_id: input.messageId,
    p_sender_user_id: input.senderUserId,
    p_requester_device_id: requesterDeviceId,
  });

  if (!error) return { ok: true, missingRpc: false };
  const message = error.message ?? 'retry request failed';
  const missingRpc = error.code === 'PGRST202' || /function .*not.*found|schema cache/i.test(message);
  return { ok: false, missingRpc, message };
}

async function requestRetry(input: RetryRequestInput, mode: 'device_copy_retry' | 'message_refanout'): Promise<boolean> {
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
    const preferredRpc = mode === 'message_refanout'
      ? 'request_message_refanout'
      : 'request_device_copy_retry';
    let result = await sendRetryRpc(preferredRpc, input, requesterDeviceId);
    if (!result.ok && result.missingRpc && preferredRpc === 'request_message_refanout') {
      result = await sendRetryRpc('request_device_copy_retry', input, requesterDeviceId);
    }

    if (!result.ok) {
      logCryptoError({
        severity: 'warning',
        context: 'decrypt',
        errorCode: mode === 'message_refanout'
          ? 'REQUEST_MESSAGE_REFANOUT_FAILED'
          : 'DEVICE_COPY_RETRY_REQUEST_FAILED',
        errorMessage: result.message ?? 'Retry request failed',
        myDeviceId: requesterDeviceId,
        metadata: { messageId: input.messageId, senderUserId: input.senderUserId },
      });
      return false;
    }

    logCryptoError({
      severity: 'info',
      context: 'decrypt',
      errorCode: mode === 'message_refanout'
        ? 'REQUEST_MESSAGE_REFANOUT_REQUESTED'
        : 'DEVICE_COPY_RETRY_REQUESTED',
      errorMessage: mode === 'message_refanout'
        ? 'Requested message re-fanout from another same-user/sender device'
        : 'Requested a fresh encrypted device copy from sender',
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

export async function requestDeviceCopyRetry(input: RetryRequestInput): Promise<boolean> {
  return requestRetry(input, 'device_copy_retry');
}

export async function requestMessageRefanout(input: RetryRequestInput): Promise<boolean> {
  return requestRetry(input, 'message_refanout');
}

export async function getMessageRefanoutStatus(input: RetryRequestInput): Promise<MessageRefanoutStatus> {
  if (!input.messageId || !input.senderUserId || isDeviceIdTemporary()) {
    return { terminal: false, status: 'none' };
  }

  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { terminal: false, status: 'none' };
    const requesterDeviceId = getCurrentDeviceId();
    const { data, error } = await supabase
      .from('message_device_retry_requests')
      .select('status,last_error')
      .eq('message_id', input.messageId)
      .eq('sender_user_id', input.senderUserId)
      .eq('requester_user_id', user.id)
      .eq('requester_device_id', requesterDeviceId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return { terminal: false, status: 'none' };
    const status = (data.status ?? 'none') as MessageRefanoutStatus['status'];
    const terminal = status === 'failed' && /^PLAINTEXT_UNAVAILABLE:/i.test(data.last_error ?? '');
    return {
      terminal,
      status,
      errorCode: terminal ? 'REFANOUT_UNAVAILABLE' : undefined,
    };
  } catch (e) {
    logCryptoException('decrypt', e, {
      severity: 'warning',
      metadata: {
        stage: 'getMessageRefanoutStatus',
        messageId: input.messageId,
        senderUserId: input.senderUserId,
      },
    });
    return { terminal: false, status: 'none' };
  }
}
