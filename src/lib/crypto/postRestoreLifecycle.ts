import { supabase } from '@/integrations/supabase/client';
import { hasLocalKeys } from '@/lib/crypto/accountKeyBackup';
import { resyncE2EE } from '@/lib/crypto/resyncE2EE';
import { logCryptoError, logCryptoException } from '@/lib/crypto/errorLogger';
import { processDeviceCopyRetryRequests } from '@/lib/messaging/deviceCopyRetryProcessor';
import { requestMessageRefanout } from '@/lib/messaging/deviceCopyRetryRequest';
import { isUnsupportedEncryptedBody } from '@/lib/messaging/messageCompatibility';
import { getCurrentDeviceId } from '@/lib/messaging/currentDevice';

const REFANOUT_SCAN_LIMIT = 500;
const LIFECYCLE_DEBOUNCE_MS = 800;
const RESYNC_COOLDOWN_MS = 2 * 60 * 1000;

export interface PostRestoreLifecycleHandle {
  stop: () => void;
}

type LifecycleReason =
  | 'keys-restored'
  | 'keys-unlocked'
  | 'resign-device-list-needed'
  | 'skdm-refresh-needed'
  | 'request-refanout-scan';

async function ensureKeysOrRequestUnlock(userId: string, reason: LifecycleReason): Promise<boolean> {
  if (await hasLocalKeys()) return true;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('forsure:e2ee-restore-needed', {
      detail: {
        userId,
        reason: `post_restore_${reason}_keys_missing`,
        source: 'postRestoreLifecycle',
      },
    }));
  }
  return false;
}

async function requestRefanoutForUnsupportedMessages(userId: string): Promise<number> {
  const { data: conversations, error: convError } = await supabase
    .from('conversation_participants')
    .select('conversation_id')
    .eq('user_id', userId)
    .limit(150);

  if (convError || !conversations?.length) return 0;

  const conversationIds = conversations
    .map((row: { conversation_id?: string | null }) => row.conversation_id)
    .filter((id): id is string => !!id);
  if (conversationIds.length === 0) return 0;

  const { data: messages, error } = await supabase
    .from('messages')
    .select('id, body, sender_id, conversation_id')
    .in('conversation_id', conversationIds)
    .in('status', ['delivered', 'pending'])
    .order('created_at', { ascending: false })
    .limit(REFANOUT_SCAN_LIMIT);

  if (error || !messages?.length) return 0;

  let requested = 0;
  for (const message of messages as Array<{
    id: string;
    body: string | null;
    sender_id: string | null;
    conversation_id: string | null;
  }>) {
    if (!message.id || !message.sender_id) continue;
    if (!isUnsupportedEncryptedBody(message.body)) continue;
    const ok = await requestMessageRefanout({
      messageId: message.id,
      senderUserId: message.sender_id,
    });
    if (ok) requested++;
  }
  return requested;
}

export function startPostRestoreLifecycle(userId: string): PostRestoreLifecycleHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resyncInFlight: Promise<void> | null = null;
  let refanoutInFlight: Promise<void> | null = null;
  let lastResyncAt = 0;

  const emitDecryptRetry = () => {
    try {
      window.dispatchEvent(new CustomEvent('forsure-decrypt-retry'));
    } catch {
      // SSR safe.
    }
  };

  const runResync = async (reason: LifecycleReason) => {
    if (stopped) return;
    if (!(await ensureKeysOrRequestUnlock(userId, reason))) return;
    if (Date.now() - lastResyncAt < RESYNC_COOLDOWN_MS && reason !== 'resign-device-list-needed') return;
    if (resyncInFlight) return resyncInFlight;

    resyncInFlight = (async () => {
      try {
        lastResyncAt = Date.now();
        const report = await resyncE2EE(userId, { diagnostic: false });
        logCryptoError({
          severity: report.ok ? 'info' : report.needsPinUnlock ? 'warning' : 'error',
          context: 'restore',
          errorCode: report.ok ? 'POST_RESTORE_RESYNC_OK' : 'POST_RESTORE_RESYNC_INCOMPLETE',
          errorMessage: report.ok ? 'Post-restore E2EE lifecycle resync completed' : 'Post-restore E2EE lifecycle resync incomplete',
          myDeviceId: report.deviceId ?? getCurrentDeviceId(),
          metadata: {
            userId,
            reason,
            steps: report.steps,
            errors: report.errors,
            recoveredMessages: report.recoveredMessages,
            scannedMessages: report.scannedMessages,
          },
        });
        emitDecryptRetry();
      } catch (e) {
        logCryptoException('restore', e, {
          severity: 'warning',
          myDeviceId: getCurrentDeviceId(),
          metadata: { stage: 'post_restore_resync', userId, reason },
        });
      } finally {
        resyncInFlight = null;
      }
    })();

    return resyncInFlight;
  };

  const runRefanoutScan = async (reason: LifecycleReason) => {
    if (stopped) return;
    if (!(await ensureKeysOrRequestUnlock(userId, reason))) return;
    if (refanoutInFlight) return refanoutInFlight;

    refanoutInFlight = (async () => {
      try {
        const requested = await requestRefanoutForUnsupportedMessages(userId);
        const processed = await processDeviceCopyRetryRequests();
        logCryptoError({
          severity: 'info',
          context: 'restore',
          errorCode: 'POST_RESTORE_REFANOUT_SCAN',
          errorMessage: 'Post-restore refanout scan completed',
          myDeviceId: getCurrentDeviceId(),
          metadata: { userId, reason, requested, processed },
        });
        emitDecryptRetry();
      } catch (e) {
        logCryptoException('restore', e, {
          severity: 'warning',
          myDeviceId: getCurrentDeviceId(),
          metadata: { stage: 'post_restore_refanout_scan', userId, reason },
        });
      } finally {
        refanoutInFlight = null;
      }
    })();

    return refanoutInFlight;
  };

  const schedule = (reason: LifecycleReason) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (reason === 'request-refanout-scan') {
        void runRefanoutScan(reason);
        return;
      }
      void runResync(reason).then(() => runRefanoutScan(reason));
    }, LIFECYCLE_DEBOUNCE_MS);
  };

  const onKeysRestored = () => schedule('keys-restored');
  const onKeysUnlocked = () => schedule('keys-unlocked');
  const onResignNeeded = () => schedule('resign-device-list-needed');
  const onSkdmNeeded = () => schedule('skdm-refresh-needed');
  const onRefanoutScan = () => schedule('request-refanout-scan');

  window.addEventListener('forsure-keys-restored', onKeysRestored);
  window.addEventListener('forsure-keys-unlocked', onKeysUnlocked);
  window.addEventListener('forsure:e2ee-resign-device-list-needed', onResignNeeded);
  window.addEventListener('forsure:e2ee-skdm-refresh-needed', onSkdmNeeded);
  window.addEventListener('forsure:e2ee-request-refanout-scan', onRefanoutScan);

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      window.removeEventListener('forsure-keys-restored', onKeysRestored);
      window.removeEventListener('forsure-keys-unlocked', onKeysUnlocked);
      window.removeEventListener('forsure:e2ee-resign-device-list-needed', onResignNeeded);
      window.removeEventListener('forsure:e2ee-skdm-refresh-needed', onSkdmNeeded);
      window.removeEventListener('forsure:e2ee-request-refanout-scan', onRefanoutScan);
    },
  };
}
