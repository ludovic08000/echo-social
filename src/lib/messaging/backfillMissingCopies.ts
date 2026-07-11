/**
 * Auto-backfill per-device copies for recently sent messages.
 *
 * Sesame addresses a mailbox as (UserID, DeviceID). The presence of one copy
 * for an iPhone does not prove that the Windows mailbox also received one, so
 * this pass deliberately re-runs the idempotent fan-out for every bounded
 * recent message. Existing rows are kept by the upsert conflict key while
 * missing recipient_device_id rows are added.
 *
 * Plaintext is recovered from the local cache first and from the sender's
 * account-wrapped archive second. The server never receives plaintext.
 */
import { supabase } from '@/integrations/supabase/client';
import { loadPlaintext, loadPlaintextForCiphertext } from '@/lib/crypto/plaintextStore';
import { decryptArchive } from '@/lib/messaging/archive/archiveKey';
import { fanoutMessageCopies } from './multiDeviceFanout';
import { isDeviceIdTemporary } from './currentDevice';

const BACKFILL_LOOKBACK_DAYS = 14;
const BACKFILL_MAX_MESSAGES = 50;
const BACKFILL_MIN_INTERVAL_MS = 5 * 60 * 1000;

let lastRunAt = 0;
let inFlight = false;

type SentMessageRow = {
  id: string;
  conversation_id: string;
  body: string;
  archive_body?: string | null;
  created_at: string;
};

async function recoverSentPlaintext(message: SentMessageRow, userId: string): Promise<string | null> {
  const cached =
    (await loadPlaintext(message.id)) ||
    (message.body ? await loadPlaintextForCiphertext(message.body) : null);
  if (cached) return cached;

  if (!message.archive_body || !message.conversation_id) return null;
  try {
    return await decryptArchive(message.archive_body, message.conversation_id, userId);
  } catch {
    return null;
  }
}

export async function backfillMissingDeviceCopies(userId: string): Promise<{
  scanned: number;
  repaired: number;
  skipped: number;
}> {
  if (inFlight) return { scanned: 0, repaired: 0, skipped: 0 };
  if (Date.now() - lastRunAt < BACKFILL_MIN_INTERVAL_MS) {
    return { scanned: 0, repaired: 0, skipped: 0 };
  }
  if (isDeviceIdTemporary()) {
    return { scanned: 0, repaired: 0, skipped: 0 };
  }

  inFlight = true;
  lastRunAt = Date.now();

  try {
    const since = new Date(Date.now() - BACKFILL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('messages')
      .select('id, conversation_id, body, archive_body, created_at')
      .eq('sender_id', userId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(BACKFILL_MAX_MESSAGES);

    const sent = (data ?? []) as SentMessageRow[];
    if (error || sent.length === 0) {
      return { scanned: 0, repaired: 0, skipped: 0 };
    }

    let repaired = 0;
    let skipped = 0;

    // Do not reduce this list to messages with zero existing copies. A partial
    // iOS-only fan-out is precisely the case this pass must heal for Windows.
    for (const message of sent) {
      try {
        const plaintext = await recoverSentPlaintext(message, userId);
        if (!plaintext) {
          skipped += 1;
          continue;
        }

        const result = await fanoutMessageCopies({
          messageId: message.id,
          conversationId: message.conversation_id,
          senderUserId: userId,
          plaintext,
        });

        if (result.inserted > 0) repaired += 1;
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }

    if (repaired > 0) {
      console.info('[BACKFILL_FANOUT] completed missing per-device mailboxes', {
        scanned: sent.length,
        repaired,
        skipped,
      });
    }

    return { scanned: sent.length, repaired, skipped };
  } finally {
    inFlight = false;
  }
}

/** Trigger entry point — fire-and-forget and bounded. */
export function scheduleBackfillMissingDeviceCopies(userId: string, delayMs = 8000): void {
  if (!userId) return;
  setTimeout(() => {
    void backfillMissingDeviceCopies(userId).catch(() => {});
  }, delayMs);
}
