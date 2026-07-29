import { supabase } from '@/integrations/supabase/client';
import { ensureAegisDeviceReady } from '@/lib/messaging/aegisDeviceRuntime';
import { traceE2EE } from '@/lib/messaging/e2eeTrace';
import { callAegisServer } from '@/lib/messaging/aegisTransport';

export type AegisInboxRow = {
  copy_id: string;
  message_id: string;
  conversation_id: string;
  sender_user_id: string;
  sender_device_id: string;
  encrypted_body: string;
  parent_body: string;
  image_url: string | null;
  document_url: string | null;
  document_name: string | null;
  document_mime: string | null;
  document_size_bytes: number | null;
  archive_body: string | null;
  created_at: string;
};

let syncInflight: Promise<AegisInboxRow[]> | null = null;
const ackInflight = new Map<string, Promise<void>>();
const acknowledged = new Set<string>();
const MAX_ACK_CACHE = 1_000;

export async function syncAegisDeviceInbox(userId: string): Promise<AegisInboxRow[]> {
  if (syncInflight) return syncInflight;

  syncInflight = (async () => {
    const ready = await ensureAegisDeviceReady(userId);
    const { data, error } = await callAegisServer<AegisInboxRow[]>('aegis_sync_device', {
      p_device_id: ready.deviceId,
      p_limit: 100,
    });
    if (error) throw error;

    const rows = (data ?? []) as AegisInboxRow[];
    for (const row of rows) {
      traceE2EE({
        direction: 'receive',
        stage: 'SERVER_INBOX_DELIVERY',
        messageId: row.message_id,
        conversationId: row.conversation_id,
        deviceId: ready.deviceId,
        peerDeviceId: row.sender_device_id,
      });
      window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
        detail: {
          conversationId: row.conversation_id,
          messageId: row.message_id,
          reason: 'aegis-server-inbox',
        },
      }));
    }
    return rows;
  })().finally(() => {
    syncInflight = null;
  });

  return syncInflight;
}

export async function acknowledgeAegisMessage(
  userId: string,
  messageId: string,
  markRead = false,
): Promise<void> {
  if (!userId || !messageId) return;
  const key = `${userId}:${messageId}:${markRead ? 'read' : 'delivered'}`;
  if (acknowledged.has(key)) return;
  const active = ackInflight.get(key);
  if (active) return active;

  const operation = (async () => {
    const ready = await ensureAegisDeviceReady(userId);
    const { error } = await callAegisServer<number>('aegis_ack_device_messages', {
      p_device_id: ready.deviceId,
      p_mark_read: markRead,
      p_message_ids: [messageId],
    });
    if (error) throw error;
    acknowledged.add(key);
    while (acknowledged.size > MAX_ACK_CACHE) {
      const oldest = acknowledged.values().next().value;
      if (oldest === undefined) break;
      acknowledged.delete(oldest);
    }
    traceE2EE({
      direction: 'receive',
      stage: markRead ? 'SERVER_INBOX_READ_ACK' : 'SERVER_INBOX_DURABLE_ACK',
      messageId,
      deviceId: ready.deviceId,
    });
  })().finally(() => {
    ackInflight.delete(key);
  });

  ackInflight.set(key, operation);
  return operation;
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
  timer = setInterval(sync, 15_000);
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
