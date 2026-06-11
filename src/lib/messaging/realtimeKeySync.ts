/**
 * Realtime Key Sync
 *
 * Subscribes to Supabase Realtime on the tables that drive E2EE readiness:
 *   - user_public_keys
 *   - user_devices
 *   - signed_prekeys
 *   - device_signed_prekeys
 *   - device_one_time_prekeys
 *
 * Whenever ANY of these tables changes (peer publishes a new SPK, peer comes
 * online with a fresh device, OPK pool refilled, …) we trigger a silent
 * `messageQueue.resumeAll()` so any message that was waiting on a missing
 * bundle is retried automatically. UX result: WhatsApp-style invisible queue.
 *
 * EPOCH-AWARE INVALIDATION (Lot 1 — Signal-style recovery):
 *   When a row in `device_signed_prekeys` is UPDATED with a higher `keys_epoch`
 *   AND the affected user is NOT us, we eagerly invalidate every cached
 *   Double-Ratchet session we hold with that peer device. The next outbound
 *   message will then re-run X3DH against the fresh bundle, healing the
 *   silent-decryption window after the peer restored from backup.
 *
 * Strict rules:
 *   - never log key material
 *   - never expose plaintext
 *   - debounced so a burst of changes ≠ a burst of resume calls
 *   - cleanly torn down on logout / unmount
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

/**
 * Handle a UPDATE on `device_signed_prekeys`. If the peer (NOT us) bumped
 * `keys_epoch`, drop our cached session — next message will re-run X3DH.
 */
async function handleDeviceSpkUpdate(payload: any, selfUserId: string): Promise<void> {
  try {
    const newRow = payload?.new;
    const oldRow = payload?.old;
    if (!newRow || typeof newRow !== 'object') return;

    const peerUserId = newRow.user_id as string | undefined;
    const peerDeviceId = newRow.device_id as string | undefined;
    if (!peerUserId || !peerDeviceId) return;
    if (peerUserId === selfUserId) return; // own device → not a peer rotation

    const newEpoch = Number(newRow.keys_epoch ?? 0);
    const oldEpoch = Number(oldRow?.keys_epoch ?? 0);
    if (!(newEpoch > oldEpoch)) return; // not an epoch bump

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
      'postgres_changes' as any,
      { event: '*', schema: 'public', table },
      (payload: any) => {
        scheduleResume(`${payload?.table ?? table}:${payload?.eventType ?? 'change'}`);
        // Epoch-aware session invalidation on peer SPK rotation/restore.
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
