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

async function getState(userId: string): Promise<MessagingApiState> {
  const crypto = await cryptoApi.getState(userId);
  if (crypto.state !== 'ready') return 'blocked';
  return getAccountSynchronizationPhase(userId) === 'syncing' ? 'syncing' : 'ready';
}

async function ensureReady(userId: string): Promise<void> {
  // An approval-triggered account synchronization may be the operation that
  // finalizes lifecycle_status=ready. Waiting for that bounded operation first
  // avoids reporting a transient CRYPTO_NOT_READY while the canonical pipeline
  // is still completing. The strict crypto check remains the final authority.
  await waitForAccountSynchronization(userId);
  await cryptoApi.ensureReady(userId);
}

async function send(input: AegisOutboundInput): Promise<AegisOutboundResult> {
  await ensureReady(input.senderUserId);
  return sendAegisOutboundMessage(input);
}

async function syncInbox(userId: string): Promise<void> {
  await ensureReady(userId);
  await syncAegisDeviceInbox(userId);
}

/** Start the canonical messaging runtime and return the React-compatible cleanup. */
function startRuntime(userId: string): () => void {
  let stopped = false;
  let started = false;
  let starting = false;
  let retryAttempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopRealtime: (() => void) | null = null;
  let stopInbox: (() => void) | null = null;

  const clearRetryTimer = () => {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  const scheduleRetry = () => {
    if (stopped || started || retryTimer) return;
    const delay = Math.min(
      RUNTIME_RETRY_BASE_MS * (2 ** Math.min(Math.max(retryAttempt - 1, 0), 4)),
      RUNTIME_RETRY_MAX_MS,
    );
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void tryStart();
    }, delay);
  };

  const tryStart = async () => {
    if (stopped || started || starting) return;
    starting = true;
    try {
      await ensureReady(userId);
      if (stopped || started) return;
      stopRealtime = startRealtimeKeySync({ userId });
      stopInbox = startAegisDeviceInbox(userId);
      started = true;
      retryAttempt = 0;
      clearRetryTimer();
    } catch (error) {
      if (!stopped) {
        retryAttempt += 1;
        console.warn('[messagingApi] runtime start deferred', error);
        scheduleRetry();
      }
    } finally {
      starting = false;
    }
  };

  const retryNow = () => {
    if (stopped || started) return;
    clearRetryTimer();
    void tryStart();
  };

  const onAccountSyncState = (event: Event) => {
    const detail = (event as CustomEvent<{ userId?: string; phase?: string }>).detail;
    if (detail?.userId === userId && detail.phase === 'ready') retryNow();
  };

  window.addEventListener('online', retryNow);
  window.addEventListener('focus', retryNow);
  window.addEventListener('forsure-keys-restored', retryNow);
  window.addEventListener('forsure-keys-unlocked', retryNow);
  window.addEventListener('forsure:aegis-route-ready', retryNow);
  window.addEventListener('forsure:account-sync-state', onAccountSyncState);

  void tryStart();

  return () => {
    stopped = true;
    clearRetryTimer();
    window.removeEventListener('online', retryNow);
    window.removeEventListener('focus', retryNow);
    window.removeEventListener('forsure-keys-restored', retryNow);
    window.removeEventListener('forsure-keys-unlocked', retryNow);
    window.removeEventListener('forsure:aegis-route-ready', retryNow);
    window.removeEventListener('forsure:account-sync-state', onAccountSyncState);
    stopRealtime?.();
    stopInbox?.();
    stopRealtime = null;
    stopInbox = null;
  };
}

const RUNTIME_RETRY_BASE_MS = 2_000;
const RUNTIME_RETRY_MAX_MS = 30_000;

export const messagingApi = {
  getState,
  ensureReady,
  send,
  syncInbox,
  startRuntime,
} as const;

export const __test__ = {
  RUNTIME_RETRY_BASE_MS,
  RUNTIME_RETRY_MAX_MS,
} as const;
