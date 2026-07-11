/**
 * Realtime E2EE readiness sync.
 *
 * Besides key/prekey changes, this channel watches the two encrypted-history
 * locations. A sender archive is often committed after the parent message;
 * iOS or Windows may already have cached a failed decrypt by then. The targeted
 * retry event invalidates that message only and lets the archive path resolve.
 */
import { supabase } from '@/integrations/supabase/client';
import { messageQueue } from './messageQueue';
import { getCurrentDeviceId } from './currentDevice';
import { invalidateDeviceSession } from '@/lib/crypto/deviceRatchet';

const KEY_TABLES = [
  'user_public_keys',
  'user_devices',
  'signed_prekeys',
  'device_signed_prekeys',
  'device_one_time_prekeys',
] as const;

let activeChannel: ReturnType<typeof supabase.channel> | null = null;
let activeUserId: string | null = null;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;
let lastResumeAt = 0;

const RESUME_DEBOUNCE_MS = 600;
const RESUME_MIN_INTERVAL_MS = 1500;

function dispatchTargetedDecryptRetry(messageId: string | null | undefined, reason: string): void {
  if (!messageId || typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
      detail: { messageId, reason },
    }));
  } catch {
    // Browser/UI wakeup is best-effort and contains no key material.
  }
}

function scheduleResume(reason: string): void {
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => {
    resumeTimer = null;
    const now = Date.now();
    if (now - lastResumeAt < RESUME_MIN_INTERVAL_MS) {
      scheduleResume(reason);
      return;
    }
    lastResumeAt = now;
    void messageQueue.resumeAll().catch(err => {
      console.warn('[RT_KEYS] resumeAll failed:', err);
    });
    if (typeof console !== 'undefined') {
      console.log(`[RT_KEYS] resumeAll triggered by ${reason}`);
    }
  }, RESUME_DEBOUNCE_MS);
}

/** Drop a peer-device session after a keys_epoch bump. */
async function handleDeviceSpkUpdate(payload: any, selfUserId: string): Promise<void> {
  try {
    const newRow = payload?.new;
    const oldRow = payload?.old;
    if (!newRow || typeof newRow !== 'object') return;

    const peerUserId = newRow.user_id as string | undefined;
    const peerDeviceId = newRow.device_id as string | undefined;
    if (!peerUserId || !peerDeviceId || peerUserId === selfUserId) return;

    const newEpoch = Number(newRow.keys_epoch ?? 0);
    const oldEpoch = Number(oldRow?.keys_epoch ?? 0);
    if (!(newEpoch > oldEpoch)) return;

    const myDeviceId = (() => {
      try { return getCurrentDeviceId(); } catch { return null; }
    })();
    if (!myDeviceId) return;

    await invalidateDeviceSession(selfUserId, myDeviceId, peerUserId, peerDeviceId);
    console.log('[RT_KEYS] peer keys_epoch bump → session invalidated', {
      peer: peerUserId.slice(0, 8),
      device: peerDeviceId.slice(0, 8),
      oldEpoch,
      newEpoch,
    });
  } catch (e) {
    console.warn('[RT_KEYS] handleDeviceSpkUpdate failed:', e);
  }
}

function handleSenderArchiveUpdate(payload: any): void {
  const next = payload?.new;
  const previous = payload?.old;
  const messageId = next?.id as string | undefined;
  const nextArchive = next?.archive_body as string | null | undefined;
  const previousArchive = previous?.archive_body as string | null | undefined;
  if (!messageId || !nextArchive || nextArchive === previousArchive) return;
  dispatchTargetedDecryptRetry(messageId, 'sender_archive_available');
}

function handleRecipientArchiveUpdate(payload: any): void {
  const row = payload?.new;
  const messageId = row?.message_id as string | undefined;
  const archiveBody = row?.archive_body as string | null | undefined;
  if (!messageId || !archiveBody) return;
  dispatchTargetedDecryptRetry(messageId, 'recipient_archive_available');
}

export interface RealtimeKeySyncOptions {
  userId: string;
}

export function startRealtimeKeySync({ userId }: RealtimeKeySyncOptions): () => void {
  if (!userId) return () => {};

  if (activeChannel && activeUserId === userId) {
    return () => stopRealtimeKeySync();
  }
  if (activeChannel) stopRealtimeKeySync();

  activeUserId = userId;
  const channel = supabase.channel(`e2ee-keys-${userId}`);

  for (const table of KEY_TABLES) {
    channel.on(
      'postgres_changes' as any,
      { event: '*', schema: 'public', table },
      (payload: any) => {
        scheduleResume(`${payload?.table ?? table}:${payload?.eventType ?? 'change'}`);
        if (table === 'device_signed_prekeys' && payload?.eventType === 'UPDATE') {
          void handleDeviceSpkUpdate(payload, userId);
        }
      },
    );
  }

  // Sender-owned archive_body is written asynchronously after the message row.
  channel.on(
    'postgres_changes' as any,
    {
      event: 'UPDATE',
      schema: 'public',
      table: 'messages',
      filter: `sender_id=eq.${userId}`,
    },
    handleSenderArchiveUpdate,
  );

  // Received messages are archived per viewer in message_archives.
  channel.on(
    'postgres_changes' as any,
    {
      event: '*',
      schema: 'public',
      table: 'message_archives',
      filter: `user_id=eq.${userId}`,
    },
    handleRecipientArchiveUpdate,
  );

  channel.subscribe(status => {
    if (status === 'SUBSCRIBED') {
      console.log('[RT_KEYS] subscribed');
      scheduleResume('subscribe');
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      console.warn('[RT_KEYS] channel status:', status);
    }
  });

  activeChannel = channel;
  return () => stopRealtimeKeySync();
}

export function stopRealtimeKeySync(): void {
  if (resumeTimer) {
    clearTimeout(resumeTimer);
    resumeTimer = null;
  }
  if (activeChannel) {
    try {
      supabase.removeChannel(activeChannel);
    } catch (err) {
      console.warn('[RT_KEYS] removeChannel failed:', err);
    }
  }
  activeChannel = null;
  activeUserId = null;
}

export const __test__ = {
  handleSenderArchiveUpdate,
  handleRecipientArchiveUpdate,
};
