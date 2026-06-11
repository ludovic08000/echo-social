import { QueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { getCurrentDeviceId } from '@/lib/messaging/currentDevice';
import { tryReadDeviceCopy } from '@/lib/messaging/multiDeviceFanout';
import { processDeviceCopyRetryRequests } from '@/lib/messaging/deviceCopyRetryProcessor';
import { syncChatPinBackupToServer, syncKeychainSnapshotFromLocal } from '@/lib/crypto/accountKeyBackup';
import { logCryptoError, logCryptoException } from '@/lib/crypto/errorLogger';

export type MultiDeviceSyncStatus =
  | 'idle'
  | 'listening'
  | 'decrypting_copy'
  | 'backup_syncing'
  | 'backup_ok'
  | 'error';

export interface MultiDeviceSyncOptions {
  userId: string;
  conversationId?: string;
  queryClient?: QueryClient;
  chatPin?: string | null;
  chatPinBackupSecret?: string | null;
}

export interface MultiDeviceSyncController {
  stop: () => void;
  syncBackupNow: () => Promise<boolean>;
}

const activeControllers = new Map<string, MultiDeviceSyncController>();
const lastBackupSyncAt = new Map<string, number>();
const BACKUP_SYNC_DEBOUNCE_MS = 30_000;

function controllerKey(userId: string, conversationId?: string): string {
  return `${userId}:${conversationId ?? 'global'}`;
}

function emitStatus(status: MultiDeviceSyncStatus, detail: Record<string, unknown> = {}) {
  try {
    window.dispatchEvent(new CustomEvent('forsure:multi-device-sync-status', {
      detail: { status, ...detail },
    }));
  } catch {
    // SSR / tests
  }
}

function invalidateMessaging(queryClient: QueryClient | undefined, conversationId?: string) {
  if (!queryClient) return;
  if (conversationId) {
    queryClient.invalidateQueries({ queryKey: ['messages', conversationId] });
  } else {
    queryClient.invalidateQueries({ queryKey: ['messages'] });
  }
  queryClient.invalidateQueries({ queryKey: ['conversations'] });
}

async function decryptAndNotify(messageId: string, senderUserId?: string | null): Promise<boolean> {
  emitStatus('decrypting_copy', { messageId });
  const plaintext = await tryReadDeviceCopy(messageId, senderUserId ?? undefined);
  if (plaintext === null) return false;
  try {
    window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
      detail: { messageId, plaintextAvailable: true },
    }));
  } catch {
    // SSR / tests
  }
  return true;
}

/**
 * Start realtime sync for device copies + messages.
 *
 * This is intentionally additive:
 * - it does not replace the existing useMessages realtime channel;
 * - it watches `message_device_copies` specifically, which is the table that
 *   makes WhatsApp-style multi-device delivery work;
 * - it invalidates React Query caches and triggers decrypt retries when a new
 *   copy for the current device arrives.
 */
export function startMultiDeviceRealtimeSync(options: MultiDeviceSyncOptions): MultiDeviceSyncController {
  const key = controllerKey(options.userId, options.conversationId);
  const existing = activeControllers.get(key);
  if (existing) return existing;

  const myDeviceId = getCurrentDeviceId();
  const channel = supabase
    .channel(`multi-device-sync:${key}:${myDeviceId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'message_device_copies',
        filter: `recipient_device_id=eq.${myDeviceId}`,
      },
      async (payload) => {
        const row = payload.new as {
          message_id?: string;
          sender_user_id?: string;
          recipient_user_id?: string;
          recipient_device_id?: string;
        };
        if (!row.message_id) return;
        if (row.recipient_user_id && row.recipient_user_id !== options.userId) return;

        try {
          await decryptAndNotify(row.message_id, row.sender_user_id);
          invalidateMessaging(options.queryClient, options.conversationId);
          await processDeviceCopyRetryRequests().catch(() => undefined);
        } catch (error) {
          emitStatus('error', { stage: 'device_copy_insert', messageId: row.message_id });
          logCryptoException('decrypt', error, {
            severity: 'warning',
            myDeviceId,
            metadata: { stage: 'multi_device_realtime_copy', messageId: row.message_id },
          });
        }
      },
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'messages',
        filter: options.conversationId ? `conversation_id=eq.${options.conversationId}` : undefined,
      },
      () => {
        invalidateMessaging(options.queryClient, options.conversationId);
      },
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        emitStatus('listening', { userId: options.userId, conversationId: options.conversationId, deviceId: myDeviceId });
      }
    });

  const syncBackupNow = async (): Promise<boolean> => {
    const now = Date.now();
    const last = lastBackupSyncAt.get(options.userId) ?? 0;
    if (now - last < BACKUP_SYNC_DEBOUNCE_MS) return true;
    lastBackupSyncAt.set(options.userId, now);

    emitStatus('backup_syncing', { userId: options.userId });
    try {
      let ok = false;
      if (options.chatPin && options.chatPinBackupSecret) {
        ok = await syncChatPinBackupToServer(options.userId, options.chatPin, options.chatPinBackupSecret);
      }
      const snapshotOk = await syncKeychainSnapshotFromLocal(options.userId).catch(() => false);
      ok = ok || snapshotOk;
      emitStatus(ok ? 'backup_ok' : 'error', { userId: options.userId, stage: 'backup_sync' });
      if (!ok) {
        logCryptoError({
          severity: 'warning',
          context: 'backup',
          errorCode: 'MULTI_DEVICE_BACKUP_SYNC_EMPTY',
          errorMessage: 'No E2EE backup/snapshot could be synchronized',
          metadata: { userId: options.userId },
        });
      }
      return ok;
    } catch (error) {
      emitStatus('error', { userId: options.userId, stage: 'backup_sync' });
      logCryptoException('backup', error, {
        severity: 'error',
        metadata: { stage: 'multi_device_backup_sync', userId: options.userId },
      });
      return false;
    }
  };

  const onKeysRestored = () => {
    invalidateMessaging(options.queryClient, options.conversationId);
    void processDeviceCopyRetryRequests().catch(() => undefined);
    void syncBackupNow();
  };

  const onOnline = () => {
    invalidateMessaging(options.queryClient, options.conversationId);
    void processDeviceCopyRetryRequests().catch(() => undefined);
    void syncBackupNow();
  };

  try {
    window.addEventListener('forsure-keys-restored', onKeysRestored);
    window.addEventListener('forsure-keys-unlocked', onKeysRestored);
    window.addEventListener('online', onOnline);
  } catch {
    // SSR / tests
  }

  const controller: MultiDeviceSyncController = {
    stop: () => {
      try {
        window.removeEventListener('forsure-keys-restored', onKeysRestored);
        window.removeEventListener('forsure-keys-unlocked', onKeysRestored);
        window.removeEventListener('online', onOnline);
      } catch {
        // SSR / tests
      }
      supabase.removeChannel(channel);
      activeControllers.delete(key);
      emitStatus('idle', { userId: options.userId, conversationId: options.conversationId });
    },
    syncBackupNow,
  };

  activeControllers.set(key, controller);
  return controller;
}

export function stopMultiDeviceRealtimeSync(userId: string, conversationId?: string) {
  const key = controllerKey(userId, conversationId);
  activeControllers.get(key)?.stop();
}

export interface MergeableMessageLike {
  id: string;
  sender_id: string;
  body: string | null;
  created_at: string;
  status?: string | null;
}

/**
 * Deterministic conflict/merge helper for realtime + refetch + optimistic rows.
 *
 * Rules:
 * 1. server ids win over optimistic/local ids;
 * 2. same id is merged, not duplicated;
 * 3. body marker `__lid`/`__tid` is used when present to remove local duplicates;
 * 4. final ordering is chronological, with id tie-breaker for deterministic UI.
 */
export function mergeMessagesByServerTruth<T extends MergeableMessageLike>(oldRows: T[] = [], incomingRows: T[] = []): T[] {
  const byId = new Map<string, T>();
  const optimistic: T[] = [];

  for (const row of oldRows) {
    if (row.id.startsWith('optimistic-') || row.id.startsWith('local-') || row.id.startsWith('queued-')) {
      optimistic.push(row);
    } else {
      byId.set(row.id, row);
    }
  }

  for (const row of incomingRows) {
    if (row.id.startsWith('optimistic-') || row.id.startsWith('local-') || row.id.startsWith('queued-')) {
      optimistic.push(row);
      continue;
    }
    byId.set(row.id, { ...(byId.get(row.id) as T | undefined), ...row });
  }

  const serverRows = Array.from(byId.values());
  const serverBodies = new Set(serverRows.map((m) => m.body).filter(Boolean));
  const filteredOptimistic = optimistic.filter((m) => !m.body || !serverBodies.has(m.body));

  return [...serverRows, ...filteredOptimistic].sort((a, b) => {
    const ta = new Date(a.created_at).getTime();
    const tb = new Date(b.created_at).getTime();
    if (ta !== tb) return ta - tb;
    return a.id.localeCompare(b.id);
  });
}
