import { supabase } from '@/integrations/supabase/client';
import { ensureAegisDeviceReady } from '@/lib/messaging/aegisDeviceRuntime';
import { traceE2EE } from '@/lib/messaging/e2eeTrace';

export type AegisInboxRow = {
  message_id: string;
  encrypted_body: string;
  sender_user_id: string;
  sender_device_id: string;
  recipient_device_id: string;
  created_at: string;
};

let syncInflight: Promise<AegisInboxRow[]> | null = null;
const acknowledged = new Set<string>();
const delivered = new Set<string>();
const MAX_LOCAL_CACHE = 1_000;

function rememberBounded(cache: Set<string>, key: string): void {
  cache.add(key);
  while (cache.size > MAX_LOCAL_CACHE) {
    const oldest = cache.values().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function dispatchInboxRow(row: AegisInboxRow, deviceId: string): void {
  const deliveryKey = `${deviceId}:${row.message_id}`;
  if (delivered.has(deliveryKey)) return;
  rememberBounded(delivered, deliveryKey);
  traceE2EE({
    direction: 'receive',
    stage: 'SERVER_INBOX_DELIVERY',
    messageId: row.message_id,
    deviceId,
    peerDeviceId: row.sender_device_id,
  });
  window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
    detail: {
      messageId: row.message_id,
      reason: 'aegis-device-copy',
    },
  }));
}

/**
 * Catch up the current authorized device with the final Aegis schema.
 *
 * The clean migration removes the legacy inbox and acknowledgement RPCs. The
 * canonical server path is get_device_copies_for_messages over the authorized
 * rows in message_device_copies.
 */
export async function syncAegisDeviceInbox(userId: string): Promise<AegisInboxRow[]> {
  if (syncInflight) return syncInflight;

  syncInflight = (async () => {
    const ready = await ensureAegisDeviceReady(userId);
    const { data: references, error: referenceError } = await supabase
      .from('message_device_copies')
      .select('message_id')
      .eq('recipient_user_id', userId)
      .order('created_at', { ascending: false })
      .limit(100);
    if (referenceError) throw referenceError;

    const messageIds = Array.from(new Set(
      (references ?? [])
        .map((row) => row.message_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ));
    if (messageIds.length === 0) return [];

    const { data, error } = await supabase.rpc('get_device_copies_for_messages', {
      p_message_ids: messageIds,
      p_device_id: ready.deviceId,
    });
    if (error) throw error;

    const rows = (data ?? []) as AegisInboxRow[];
    for (const row of rows) dispatchInboxRow(row, ready.deviceId);
    return rows;
  })().finally(() => {
    syncInflight = null;
  });

  return syncInflight;
}

/**
 * The final schema has no server acknowledgement RPC. Authenticated decryption
 * is persisted by decryptionService; this bounded marker only prevents
 * duplicate local work and misleading network failures.
 */
export async function acknowledgeAegisMessage(
  userId: string,
  messageId: string,
  markRead = false,
): Promise<void> {
  if (!userId || !messageId) return;
  const key = `${userId}:${messageId}:${markRead ? 'read' : 'delivered'}`;
  if (acknowledged.has(key)) return;
  rememberBounded(acknowledged, key);
  traceE2EE({
    direction: 'receive',
    stage: markRead ? 'MESSAGE_READ_LOCAL' : 'MESSAGE_DECRYPTED_LOCAL',
    messageId,
  });
}

export function startAegisDeviceInbox(userId: string): () => void {
  if (!userId) return () => {};
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const sync = () => {
    if (stopped || document.visibilityState === 'hidden' || !navigator.onLine) return;
    void syncAegisDeviceInbox(userId).catch((error) => {
      traceE2EE({
        direction: 'receive',
        stage: 'SERVER_INBOX_SYNC_FAILED',
        errorCode: error instanceof Error ? error.message.slice(0, 120) : 'UNKNOWN',
      }, 'warn');
    });
  };

  const channel = supabase
    .channel(`aegis-device-inbox:${userId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'message_device_copies',
        filter: `recipient_user_id=eq.${userId}`,
      },
      sync,
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') sync();
    });

  sync();
  timer = setInterval(sync, 30_000);
  window.addEventListener('online', sync);
  window.addEventListener('focus', sync);
  document.addEventListener('visibilitychange', sync);

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    window.removeEventListener('online', sync);
    window.removeEventListener('focus', sync);
    document.removeEventListener('visibilitychange', sync);
    void supabase.removeChannel(channel);
  };
}
