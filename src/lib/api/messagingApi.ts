import { cryptoApi } from '@/lib/api/cryptoApi';
import {
  sendAegisOutboundMessage,
  type AegisOutboundInput,
  type AegisOutboundResult,
} from '@/lib/messaging/aegisOutboundEngine';
import { startRealtimeKeySync } from '@/lib/messaging/realtimeKeySync';
import {
  startAegisDeviceInbox,
  syncAegisDeviceInbox,
} from '@/lib/messaging/aegisDeviceInbox';
import {
  waitForAccountSynchronization,
  getAccountSynchronizationPhase,
} from '@/lib/messaging/accountSyncBarrier';

export type MessagingApiState = 'blocked' | 'syncing' | 'ready';

export interface MessagingRuntimeHandle {
  stop: () => void;
}

async function getState(userId: string): Promise<MessagingApiState> {
  const crypto = await cryptoApi.getState(userId);
  if (crypto.state !== 'ready') return 'blocked';
  return getAccountSynchronizationPhase(userId) === 'syncing' ? 'syncing' : 'ready';
}

async function ensureReady(userId: string): Promise<void> {
  await cryptoApi.ensureReady(userId);
  await waitForAccountSynchronization(userId);
}

async function send(input: AegisOutboundInput): Promise<AegisOutboundResult> {
  await ensureReady(input.senderUserId);
  return sendAegisOutboundMessage(input);
}

async function syncInbox(userId: string): Promise<void> {
  await ensureReady(userId);
  await syncAegisDeviceInbox(userId);
}

/**
 * Start the messaging runtime behind the canonical crypto/sync gates.
 * The returned stop handle is synchronous so React effects can own it safely,
 * while initialization remains asynchronous and cancellable.
 */
function startRuntime(userId: string): MessagingRuntimeHandle {
  let stopped = false;
  let stopRealtime: (() => void) | null = null;
  let stopInbox: (() => void) | null = null;

  void ensureReady(userId)
    .then(() => {
      if (stopped) return;
      stopRealtime = startRealtimeKeySync({ userId });
      stopInbox = startAegisDeviceInbox(userId);
    })
    .catch((error) => {
      if (!stopped) console.warn('[messagingApi] runtime start deferred', error);
    });

  return {
    stop: () => {
      stopped = true;
      stopRealtime?.();
      stopInbox?.();
      stopRealtime = null;
      stopInbox = null;
    },
  };
}

export const messagingApi = {
  getState,
  ensureReady,
  send,
  syncInbox,
  startRuntime,
} as const;
