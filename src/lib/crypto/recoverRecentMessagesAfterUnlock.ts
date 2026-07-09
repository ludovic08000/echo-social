import { supabase } from '@/integrations/supabase/client';
import { decryptArchive, isArchivePayload } from '@/lib/messaging/archive/archiveKey';
import { tryReadDeviceCopy } from '@/lib/messaging/multiDeviceFanout';
import {
  loadPlaintext,
  loadPlaintextForCiphertext,
  savePlaintext,
  savePlaintextForCiphertext,
} from '@/lib/crypto/plaintextStore';
import {
  isMultiDeviceEnvelopeBody,
  isSecurePipelineEnvelopeBody,
  isStrictRatchetEnvelopeBody,
} from '@/lib/messaging/messageCompatibility';

type RecoverReason =
  | 'pin_unlocked'
  | 'keys_restored'
  | 'post_restore'
  | 'manual'
  | string;

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  archive_body?: string | null;
  created_at?: string | null;
}

export interface RecoverRecentMessagesReport {
  scanned: number;
  recovered: number;
  fromCache: number;
  fromArchive: number;
  fromDeviceCopy: number;
  skipped: number;
  reason: RecoverReason;
}

const RECOVERY_LIMIT = 160;
const MIN_INTERVAL_MS = 2_500;

let inFlight: Promise<RecoverRecentMessagesReport> | null = null;
let lastStartedAt = 0;

function isEncryptedMessageBody(body: string | null | undefined): body is string {
  if (!body) return false;
  return (
    isStrictRatchetEnvelopeBody(body) ||
    isMultiDeviceEnvelopeBody(body) ||
    isSecurePipelineEnvelopeBody(body) ||
    body.startsWith('sk1.') ||
    body.startsWith('x3dh') ||
    body.startsWith('x3dh5')
  );
}

function dispatchRecovered(report: RecoverRecentMessagesReport): void {
  try {
    window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
      detail: { reason: 'recent-message-recovery', report },
    }));
  } catch {}
}

async function persistRecovered(row: MessageRow, plaintext: string): Promise<void> {
  if (!plaintext) return;
  await savePlaintext(row.id, plaintext);
  if (row.body) await savePlaintextForCiphertext(row.body, plaintext);
}

async function recoverOne(userId: string, row: MessageRow): Promise<'cache' | 'archive' | 'device_copy' | null> {
  const cachedById = await loadPlaintext(row.id).catch(() => null);
  if (cachedById) {
    if (row.body) await savePlaintextForCiphertext(row.body, cachedById).catch(() => undefined);
    return 'cache';
  }

  const cachedByCipher = row.body
    ? await loadPlaintextForCiphertext(row.body).catch(() => null)
    : null;
  if (cachedByCipher) {
    await savePlaintext(row.id, cachedByCipher).catch(() => undefined);
    return 'cache';
  }

  if (row.archive_body && isArchivePayload(row.archive_body)) {
    const archived = await decryptArchive(row.archive_body, row.conversation_id, userId).catch(() => null);
    if (archived) {
      await persistRecovered(row, archived);
      return 'archive';
    }
  }

  if (isEncryptedMessageBody(row.body)) {
    const copyText = await tryReadDeviceCopy(row.id, row.sender_id).catch(() => null);
    if (copyText) {
      await persistRecovered(row, copyText);
      return 'device_copy';
    }
  }

  return null;
}

export async function recoverRecentMessagesAfterUnlock(
  userId: string,
  reason: RecoverReason = 'manual',
): Promise<RecoverRecentMessagesReport> {
  const now = Date.now();
  if (inFlight) return inFlight;
  if (now - lastStartedAt < MIN_INTERVAL_MS) {
    return {
      scanned: 0,
      recovered: 0,
      fromCache: 0,
      fromArchive: 0,
      fromDeviceCopy: 0,
      skipped: 0,
      reason,
    };
  }

  lastStartedAt = now;
  inFlight = (async () => {
    const report: RecoverRecentMessagesReport = {
      scanned: 0,
      recovered: 0,
      fromCache: 0,
      fromArchive: 0,
      fromDeviceCopy: 0,
      skipped: 0,
      reason,
    };

    try {
      const { data, error } = await (supabase as any).rpc('get_recent_recoverable_messages', {
        p_limit: RECOVERY_LIMIT,
      });

      const rows = Array.isArray(data) && !error
        ? data as MessageRow[]
        : await fallbackFetchRecentMessages(userId);

      for (const row of rows) {
        if (!row?.id || !row?.conversation_id || !row?.sender_id) {
          report.skipped++;
          continue;
        }
        if (!isEncryptedMessageBody(row.body) && !isArchivePayload(row.archive_body)) {
          report.skipped++;
          continue;
        }

        report.scanned++;
        const source = await recoverOne(userId, row);
        if (source) {
          report.recovered++;
          if (source === 'cache') report.fromCache++;
          if (source === 'archive') report.fromArchive++;
          if (source === 'device_copy') report.fromDeviceCopy++;
        }
      }

      if (report.recovered > 0) dispatchRecovered(report);
      return report;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

async function fallbackFetchRecentMessages(userId: string): Promise<MessageRow[]> {
  const { data: participants } = await supabase
    .from('conversation_participants')
    .select('conversation_id')
    .eq('user_id', userId)
    .limit(80);

  const conversationIds = [...new Set((participants || []).map((p: any) => p.conversation_id).filter(Boolean))];
  if (conversationIds.length === 0) return [];

  const { data } = await (supabase as any)
    .from('messages')
    .select('id, conversation_id, sender_id, body, archive_body, created_at')
    .in('conversation_id', conversationIds)
    .in('status', ['delivered', 'pending'])
    .order('created_at', { ascending: false })
    .limit(RECOVERY_LIMIT);

  return (data || []) as MessageRow[];
}

export function installRecoverRecentMessagesListeners(userId: string): () => void {
  if (typeof window === 'undefined' || !userId) return () => undefined;

  const handler = (event: Event) => {
    const detail = (event as CustomEvent).detail || {};
    const reason = detail?.reason || detail?.status || event.type;
    window.setTimeout(() => {
      void recoverRecentMessagesAfterUnlock(userId, reason).catch(() => undefined);
    }, 150);
  };

  window.addEventListener('forsure-keys-restored', handler as EventListener);
  window.addEventListener('forsure:e2ee-post-restore', handler as EventListener);
  window.addEventListener('forsure-keys-unlocked', handler as EventListener);

  return () => {
    window.removeEventListener('forsure-keys-restored', handler as EventListener);
    window.removeEventListener('forsure:e2ee-post-restore', handler as EventListener);
    window.removeEventListener('forsure-keys-unlocked', handler as EventListener);
  };
}
