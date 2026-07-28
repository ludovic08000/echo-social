import { useEffect } from 'react';
import { useAuth } from '@/lib/auth';
import { loadPlaintext } from '@/lib/crypto/plaintextStore';
import { getCurrentDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';
import { traceE2EE } from '@/lib/messaging/e2eeTrace';
import { encryptPlaintextForDeviceTarget } from '@/lib/messaging/multiDeviceFanout';
import { supabase } from '@/integrations/supabase/client';

type RetryRow = {
  request_id: string;
  message_id: string;
  conversation_id: string;
  requester_user_id: string;
  requester_device_id: string;
  requester_device_public_key: string;
  attempt_count: number;
};

let worker: Promise<void> | null = null;
let schemaBlockedUntil = 0;

function errorCode(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; message?: unknown; details?: unknown };
    return [value.code, value.message, value.details]
      .filter((part) => typeof part === 'string' && part.length > 0)
      .join(':') || 'AEGIS_RETRY_UNKNOWN_ERROR';
  }
  return String(error ?? 'AEGIS_RETRY_UNKNOWN_ERROR');
}

async function processPendingRetries(senderUserId: string): Promise<void> {
  if (worker || isDeviceIdTemporary() || Date.now() < schemaBlockedUntil) {
    return worker ?? Promise.resolve();
  }
  worker = (async () => {
    const senderDeviceId = getCurrentDeviceId();
    const { data, error } = await supabase.rpc('list_pending_device_copy_retries', {
      p_limit: 20,
    });
    if (error) {
      const code = errorCode(error);
      if (/could not find the function|schema cache|pgrst202/i.test(code)) {
        schemaBlockedUntil = Date.now() + 60_000;
      }
      throw error;
    }

    for (const row of (data ?? []) as RetryRow[]) {
      traceE2EE({
        direction: 'send',
        stage: 'DEVICE_COPY_RETRY_START',
        messageId: row.message_id,
        conversationId: row.conversation_id,
        deviceId: senderDeviceId,
        peerDeviceId: row.requester_device_id,
        retryCount: row.attempt_count,
      });
      try {
        const capsule = await loadPlaintext(`aegis-capsule:${row.message_id}`);
        if (!capsule) throw new Error('AEGIS_RETRY_CAPSULE_UNAVAILABLE');
        const encrypted = await encryptPlaintextForDeviceTarget({
          conversationId: row.conversation_id,
          senderUserId,
          senderDeviceId,
          recipientUserId: row.requester_user_id,
          recipientDeviceId: row.requester_device_id,
          recipientDevicePublicKey: row.requester_device_public_key,
          plaintext: capsule,
        });
        if (!encrypted) throw new Error('AEGIS_RETRY_ROUTE_UNAVAILABLE');

        const { data: completeData, error: completeError } = await supabase.rpc(
          'complete_device_copy_retry',
          {
            p_request_id: row.request_id,
            p_encrypted_body: encrypted.encryptedBody,
            p_sender_device_id: senderDeviceId,
          },
        );
        const complete = completeData as { ok?: boolean; code?: string } | null;
        if (completeError || complete?.ok !== true) {
          throw completeError ?? new Error(complete?.code ?? 'AEGIS_RETRY_COMMIT_FAILED');
        }
        traceE2EE({
          direction: 'send',
          stage: 'DEVICE_COPY_RETRY_COMPLETE',
          messageId: row.message_id,
          conversationId: row.conversation_id,
          deviceId: senderDeviceId,
          peerDeviceId: row.requester_device_id,
        });
      } catch (retryError) {
        const code = errorCode(retryError);
        try {
          await supabase.rpc('mark_device_copy_retry_failed', {
            p_request_id: row.request_id,
            p_error: code.slice(0, 500),
          });
        } catch {
          // The next bounded worker pass can retry the pending server record.
        }
        traceE2EE({
          direction: 'send',
          stage: 'DEVICE_COPY_RETRY_FAILED',
          messageId: row.message_id,
          conversationId: row.conversation_id,
          deviceId: senderDeviceId,
          peerDeviceId: row.requester_device_id,
          errorCode: code.slice(0, 120),
        }, 'warn');
      }
    }
  })().finally(() => {
    worker = null;
  });
  return worker;
}

export function useDeviceCopyRetryWorker(): void {
  const { user } = useAuth();
  useEffect(() => {
    if (!user?.id) return;
    const run = () => void processPendingRetries(user.id).catch((error) => {
      const code = errorCode(error);
      traceE2EE({
        direction: 'send',
        stage: 'DEVICE_COPY_RETRY_WORKER_FAILED',
        errorCode: code.slice(0, 120),
      }, 'warn');
    });
    run();
    const interval = window.setInterval(run, 15_000);
    const channel = supabase
      .channel(`aegis-copy-retries:${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'device_copy_retry_requests',
          filter: `sender_user_id=eq.${user.id}`,
        },
        run,
      )
      .subscribe();
    window.addEventListener('online', run);
    window.addEventListener('focus', run);
    return () => {
      window.clearInterval(interval);
      void supabase.removeChannel(channel);
      window.removeEventListener('online', run);
      window.removeEventListener('focus', run);
    };
  }, [user?.id]);
}
