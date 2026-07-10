import { supabase } from '@/integrations/supabase/client';
import { logCryptoError, logCryptoException } from '@/lib/crypto/errorLogger';
import { loadPlaintext, loadPlaintextForCiphertext } from '@/lib/crypto/plaintextStore';
import { decryptArchive, isArchivePayload } from './archive/archiveKey';
import { getCurrentDeviceId, isDeviceIdTemporary } from './currentDevice';
import { encryptPlaintextForDeviceTarget } from './multiDeviceFanout';

interface PendingDeviceCopyRetry {
  request_id: string;
  message_id: string;
  conversation_id: string;
  message_body: string;
  requester_user_id: string;
  requester_device_id: string;
  requester_device_public_key: string;
  attempt_count: number;
}

interface RetryProcessingResult {
  scanned: number;
  completed: number;
  skipped: number;
  failed: number;
}

let inFlight: Promise<RetryProcessingResult> | null = null;

async function markRetryFailed(requestId: string, errorMessage: string): Promise<void> {
  try {
    await (supabase as any).rpc('mark_device_copy_retry_failed', {
      p_request_id: requestId,
      p_error: errorMessage,
    });
  } catch {
    // Non-fatal; the next processing pass can retry the request.
  }
}

async function recoverSenderPlaintext(
  row: PendingDeviceCopyRetry,
  senderUserId: string,
): Promise<string | null> {
  const cached =
    (await loadPlaintext(row.message_id)) ||
    (row.message_body ? await loadPlaintextForCiphertext(row.message_body) : null);
  if (cached) return cached;

  // iOS can evict IndexedDB and Windows may have restarted before a delayed
  // device-copy retry arrives. The sender-side encrypted archive is the durable
  // zero-access recovery source; use it before declaring the retry impossible.
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('archive_body')
      .eq('id', row.message_id)
      .eq('sender_id', senderUserId)
      .maybeSingle();
    if (error) return null;
    const archiveBody = (data as { archive_body?: string | null } | null)?.archive_body;
    if (!archiveBody || !isArchivePayload(archiveBody)) return null;
    return decryptArchive(archiveBody, row.conversation_id, senderUserId);
  } catch {
    return null;
  }
}

export async function processDeviceCopyRetryRequests(_limit = 20): Promise<RetryProcessingResult> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const result: RetryProcessingResult = {
      scanned: 0,
      completed: 0,
      skipped: 0,
      failed: 0,
    };

    if (isDeviceIdTemporary()) return result;

    const senderDeviceId = getCurrentDeviceId();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return result;

    const { data, error } = await (supabase as any).rpc('list_pending_device_copy_retries', {
      p_limit: _limit,
    });

    if (error) {
      logCryptoError({
        severity: 'warning',
        context: 'fanout',
        errorCode: 'DEVICE_COPY_RETRY_LIST_FAILED',
        errorMessage: error.message,
        myDeviceId: senderDeviceId,
      });
      return result;
    }

    const rows = ((data as unknown) || []) as PendingDeviceCopyRetry[];
    result.scanned = rows.length;

    for (const row of rows) {
      try {
        const plaintext = await recoverSenderPlaintext(row, user.id);

        if (!plaintext) {
          result.skipped += 1;
          await markRetryFailed(row.request_id, 'plaintext_and_encrypted_archive_unavailable');
          continue;
        }

        const encrypted = await encryptPlaintextForDeviceTarget({
          conversationId: row.conversation_id,
          senderUserId: user.id,
          senderDeviceId,
          recipientUserId: row.requester_user_id,
          recipientDeviceId: row.requester_device_id,
          recipientDevicePublicKey: row.requester_device_public_key,
          plaintext,
          forceFreshSession: true,
          forceX3DH: true,
          useOneTimePrekey: true,
        });

        if (!encrypted) {
          result.failed += 1;
          await markRetryFailed(row.request_id, 'Unable to encrypt device retry copy');
          continue;
        }

        const { error: completeError } = await (supabase as any).rpc('complete_device_copy_retry', {
          p_request_id: row.request_id,
          p_encrypted_body: encrypted.encryptedBody,
          p_sender_device_id: encrypted.senderDeviceId,
        });

        if (completeError) {
          result.failed += 1;
          await markRetryFailed(row.request_id, completeError.message);
          continue;
        }

        result.completed += 1;
        try { window.dispatchEvent(new CustomEvent('forsure-decrypt-retry')); } catch {}
        logCryptoError({
          severity: 'info',
          context: 'fanout',
          errorCode: 'DEVICE_COPY_RETRY_COMPLETED',
          errorMessage: 'Regenerated encrypted device copy after retry request',
          conversationId: row.conversation_id,
          myDeviceId: senderDeviceId,
          metadata: { messageId: row.message_id, requestId: row.request_id },
        });
      } catch (e) {
        result.failed += 1;
        await markRetryFailed(
          row.request_id,
          e instanceof Error ? e.message : 'Retry processing failed',
        );
        logCryptoException('fanout', e, {
          severity: 'warning',
          conversationId: row.conversation_id,
          myDeviceId: senderDeviceId,
          metadata: { stage: 'processDeviceCopyRetryRequests', messageId: row.message_id },
        });
      }
    }

    return result;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}
