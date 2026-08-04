import { supabase } from '@/integrations/supabase/client';
import { ensureAegisDeviceReady } from '@/lib/messaging/aegisDeviceRuntime';
import {
  callAegisServer,
  getAegisTransportKind,
} from '@/lib/messaging/aegisTransport';
import { traceE2EE } from '@/lib/messaging/e2eeTrace';

export type AegisInboxRow = {
  copy_id: string;
  message_id: string;
  conversation_id: string;
  encrypted_body: string;
  parent_body: string;
  sender_user_id: string;
  sender_device_id: string;
  recipient_device_id?: string;
  created_at: string;
  expires_at: string;
};

const syncInflight = new Map<string, Promise<AegisInboxRow[]>>();
const ackInflight = new Map<string, Promise<void>>();
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

function traceTransport(): 'supabase' | 'aegis_server' {
  return getAegisTransportKind() === 'gateway' ? 'aegis_server' : 'supabase';
}

export function formatAegisInboxError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 120) || error.name.slice(0, 120) || 'UNKNOWN';
  }
  if (typeof error === 'string') {
    return error.trim().slice(0, 120) || 'UNKNOWN';
  }
  if (error && typeof error === 'object') {
    const candidate = error as {
      code?: unknown;
      message?: unknown;
      details?: unknown;
      hint?: unknown;
    };
    const parts = [candidate.code, candidate.message, candidate.details, candidate.hint]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .map((part) => part.trim());
    if (parts.length > 0) return parts.join(': ').slice(0, 120);
  }
  return 'UNKNOWN';
}

function dispatchInboxRow(row: AegisInboxRow, deviceId: string): void {
  const deliveryKey = `${deviceId}:${row.copy_id}`;
  if (delivered.has(deliveryKey)) return;
  rememberBounded(delivered, deliveryKey);
  traceE2EE({
    direction: 'receive',
    component: 'device_inbox',
    stage: 'SERVER_INBOX_DELIVERY',
    outcome: 'ok',
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
 * Pull the current authorized device's pending encrypted capsules.
 *
 * The security-definer RPC authenticates both auth.uid() and DeviceID. The
 * client never enumerates message IDs and never reads message_device_copies or
 * aegis_device_inbox directly.
 */
export async function syncAegisDeviceInbox(userId: string): Promise<AegisInboxRow[]> {
  const startedAt = Date.now();
  const transport = traceTransport();
  traceE2EE({
    direction: 'receive',
    component: 'device_inbox',
    stage: 'INBOX_SYNC',
    outcome: 'start',
    transport,
  });
  const ready = await ensureAegisDeviceReady(userId);
  if (ready.userId !== userId) {
    throw new Error('AEGIS_DEVICE_USER_MISMATCH');
  }

  const syncKey = `${userId}:${ready.deviceId}`;
  const active = syncInflight.get(syncKey);
  if (active) return active;

  const operation = (async () => {
    const { data, error } = await callAegisServer<AegisInboxRow[]>(
      'aegis_sync_device',
      {
        p_device_id: ready.deviceId,
        p_limit: 100,
      },
    );
    if (error) throw error;

    const rows = data ?? [];
    for (const row of rows) dispatchInboxRow(row, ready.deviceId);
    traceE2EE({
      direction: 'receive',
      component: 'device_inbox',
      stage: 'INBOX_SYNC',
      outcome: rows.length > 0 ? 'ok' : 'skip',
      deviceId: ready.deviceId,
      targetCount: rows.length,
      copyCount: rows.length,
      blockMs: Date.now() - startedAt,
      transport,
    });
    return rows;
  })();

  syncInflight.set(syncKey, operation);
  try {
    return await operation;
  } finally {
    if (syncInflight.get(syncKey) === operation) syncInflight.delete(syncKey);
  }
}

/**
 * Persist the server ACK only after authenticated decryption and durable local
 * storage. The RPC is idempotent and bound to auth.uid() plus the current
 * authorized DeviceID.
 */
export async function acknowledgeAegisMessage(
  userId: string,
  messageId: string,
  markRead = false,
): Promise<void> {
  if (!userId || !messageId) return;

  const ready = await ensureAegisDeviceReady(userId);
  if (ready.userId !== userId) {
    throw new Error('AEGIS_DEVICE_USER_MISMATCH');
  }

  const key = `${userId}:${ready.deviceId}:${messageId}:${markRead ? 'read' : 'delivered'}`;
  if (acknowledged.has(key)) return;

  const active = ackInflight.get(key);
  if (active) return active;

  const operation = (async () => {
    const { error } = await callAegisServer<number>(
      'aegis_ack_device_messages',
      {
        p_device_id: ready.deviceId,
        p_message_ids: [messageId],
        p_mark_read: markRead,
      },
    );
    if (error) throw error;

    rememberBounded(acknowledged, key);
    traceE2EE({
      direction: 'receive',
      component: 'device_inbox',
      stage: markRead ? 'MESSAGE_READ_LOCAL' : 'SERVER_INBOX_DURABLE_ACK',
      outcome: 'ok',
      messageId,
      deviceId: ready.deviceId,
      transport: traceTransport(),
    });
  })();

  ackInflight.set(key, operation);
  try {
    return await operation;
  } finally {
    if (ackInflight.get(key) === operation) ackInflight.delete(key);
  }
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
        component: 'device_inbox',
        stage: 'SERVER_INBOX_SYNC_FAILED',
        outcome: 'error',
        errorCode: formatAegisInboxError(error),
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
        table: 'messages',
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
