/**
 * Realtime E2EE readiness sync.
 *
 * Key/prekey changes invalidate stale routes and wake durable Aegis
 * outboxes. Message delivery itself is handled by the atomic parent+copies RPC.
 */
import { supabase } from '@/integrations/supabase/client';
import { getCurrentDeviceId } from './currentDevice';
import { invalidateDeviceSession } from '@/lib/crypto/deviceRatchet';
import { invalidateAllFanoutRoutes } from '@/lib/messaging/fanoutRouteCache';

const KEY_TABLES = [
  'user_public_keys',
  'user_devices',
  'signed_prekeys',
  'device_signed_prekeys',
  'device_one_time_prekeys',
  'user_identity_roots',
  'user_device_signatures',
] as const;

let activeChannel: ReturnType<typeof supabase.channel> | null = null;
let activeUserId: string | null = null;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;
let lastResumeAt = 0;

const RESUME_DEBOUNCE_MS = 600;
const RESUME_MIN_INTERVAL_MS = 1500;

interface KeyChangePayload {
  new?: Record<string, unknown>;
  old?: Record<string, unknown>;
  table?: string;
  eventType?: string;
}

function scheduleResume(reason: string): void {
  // A trust publication makes a cached empty route immediately obsolete.
  invalidateAllFanoutRoutes();
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => {
    resumeTimer = null;
    const now = Date.now();
    if (now - lastResumeAt < RESUME_MIN_INTERVAL_MS) {
      scheduleResume(reason);
      return;
    }
    lastResumeAt = now;
    try {
      window.dispatchEvent(new CustomEvent('forsure:aegis-route-ready', { detail: { reason } }));
    } catch { /* browser wakeup is best-effort */ }
  }, RESUME_DEBOUNCE_MS);
}

/** Drop a peer-device session after a keys_epoch bump. */
async function handleDeviceSpkUpdate(payload: KeyChangePayload, selfUserId: string): Promise<void> {
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
      'postgres_changes',
      { event: '*', schema: 'public', table },
      (payload: KeyChangePayload) => {
        scheduleResume(`${payload?.table ?? table}:${payload?.eventType ?? 'change'}`);
        if (table === 'device_signed_prekeys' && payload?.eventType === 'UPDATE') {
          void handleDeviceSpkUpdate(payload, userId);
        }
      },
    );
  }

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
