import { supabase } from '@/integrations/supabase/client';
import { ensureOwnReceivingKeysPublished } from '@/lib/crypto/autoKeyProvisioning';
import { messageQueue } from '@/lib/messaging/messageQueue';

export interface RealtimeKeySyncOptions {
  userId: string;
  conversationId?: string;
}

export interface RealtimeKeySyncController {
  stop: () => void;
  refreshNow: () => Promise<void>;
}

const controllers = new Map<string, RealtimeKeySyncController>();

function keyFor(options: RealtimeKeySyncOptions) {
  return `${options.userId}:${options.conversationId || 'global'}`;
}

function emitKeySync(event: string, detail: Record<string, unknown> = {}) {
  try {
    window.dispatchEvent(new CustomEvent(`forsure:key-sync:${event}`, { detail }));
  } catch {
    // non-browser/test
  }
}

/**
 * Realtime key sync coordinator.
 *
 * Purpose:
 * - publish this user's receiving keys as soon as local E2EE is unlocked;
 * - watch server key tables in realtime;
 * - resume message queue when peer keys/prekeys appear or rotate;
 * - avoid visible "waiting for key" errors when a retry can heal automatically.
 *
 * It never creates recipient/provisional keys. Only the real account/device may
 * publish its own receiving material.
 */
export function startRealtimeKeySync(options: RealtimeKeySyncOptions): RealtimeKeySyncController {
  const id = keyFor(options);
  const existing = controllers.get(id);
  if (existing) return existing;

  let stopped = false;

  const refreshNow = async () => {
    if (stopped) return;
    const result = await ensureOwnReceivingKeysPublished(options.userId);
    emitKeySync('own-refresh', { ...result, userId: options.userId });
    if (options.conversationId) {
      await messageQueue.resumeForConversation(options.conversationId).catch(() => undefined);
    } else {
      await messageQueue.resumeAll().catch(() => undefined);
    }
  };

  const resumeQueue = () => {
    if (stopped) return;
    if (options.conversationId) {
      void messageQueue.resumeForConversation(options.conversationId).catch(() => undefined);
    } else {
      void messageQueue.resumeAll().catch(() => undefined);
    }
  };

  const channel = supabase
    .channel(`e2ee-key-sync:${id}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'user_public_keys' }, (payload) => {
      emitKeySync('user-public-keys', { payload });
      resumeQueue();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'signed_prekeys' }, (payload) => {
      emitKeySync('signed-prekeys', { payload });
      resumeQueue();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'device_signed_prekeys' }, (payload) => {
      emitKeySync('device-signed-prekeys', { payload });
      resumeQueue();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'device_one_time_prekeys' }, (payload) => {
      emitKeySync('device-one-time-prekeys', { payload });
      resumeQueue();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'user_devices' }, (payload) => {
      emitKeySync('user-devices', { payload });
      resumeQueue();
    })
    .subscribe((status) => {
      emitKeySync('subscription', { status, userId: options.userId, conversationId: options.conversationId });
      if (status === 'SUBSCRIBED') {
        void refreshNow();
      }
    });

  const onKeysReady = () => void refreshNow();
  const onOnline = () => void refreshNow();

  try {
    window.addEventListener('forsure-keys-unlocked', onKeysReady);
    window.addEventListener('forsure-keys-restored', onKeysReady);
    window.addEventListener('online', onOnline);
  } catch {
    // non-browser/test
  }

  const controller: RealtimeKeySyncController = {
    stop: () => {
      stopped = true;
      try {
        window.removeEventListener('forsure-keys-unlocked', onKeysReady);
        window.removeEventListener('forsure-keys-restored', onKeysReady);
        window.removeEventListener('online', onOnline);
      } catch {
        // non-browser/test
      }
      supabase.removeChannel(channel);
      controllers.delete(id);
    },
    refreshNow,
  };

  controllers.set(id, controller);
  return controller;
}

export function stopRealtimeKeySync(userId: string, conversationId?: string) {
  const controller = controllers.get(`${userId}:${conversationId || 'global'}`);
  controller?.stop();
}
