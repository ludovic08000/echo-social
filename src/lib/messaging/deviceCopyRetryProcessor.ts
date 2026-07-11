import { supabase } from '@/integrations/supabase/client';
import { logCryptoError, logCryptoException } from '@/lib/crypto/errorLogger';
import { loadPlaintext, loadPlaintextForCiphertext } from '@/lib/crypto/plaintextStore';
import { decryptArchive } from '@/lib/messaging/archive/archiveKey';
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

/**
 * Sesame keeps a MessageRecord so an undecryptable message can be encrypted
 * again under a fresh session. Our local plaintext cache is the first source;
 * the account-wrapped archive is the durable MessageRecord equivalent when
 * iOS/Windows has already lost that cache.
 */
async function recoverRetryPlaintext(
  row: PendingDeviceCopyRetry,
  senderUserId: string,
): Promise<string | null> {
  const cached =
    (await loadPlaintext(row.message_id)) ||
    (row.message_body ? await loadPlaintextForCiphertext(row.message_body) : null);
  if (cached) return cached;

  try {
    const { data, error } = await supabase
      .from('messages')
      .select('archive_body, conversation_id')
      .eq('id', row.message_id)
      .eq('sender_id', senderUserId)
      .maybeSingle();
    if (error || !data) return null;

    const archiveBody = (data as any).archive_body as string | null | undefined;
    const conversationId = ((data as any).conversation_id as string | null | undefined) || row.conversation_id;
    if (!archiveBody || !conversationId) return null;

    return await decryptArchive(archiveBody, conversationId, senderUserId);
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
        const plaintext = await recoverRetryPlaintext(row, user.id);

        if (!plaintext) {
          result.skipped += 1;
          await markRetryFailed(row.request_id, 'plaintext_and_archive_unavailable');
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
          useOneTimePrekey: false,
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
        try {
          window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
            detail: { messageId: row.message_id, reason: 'sesame_retry_completed' },
          }));
        } catch {}
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
