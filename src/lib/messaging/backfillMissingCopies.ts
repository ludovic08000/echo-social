/**
 * Auto-backfill missing per-device copies for messages this device sent before
 * the multi-device fan-out was wired in `useMessageQueue`.
 *
 * Strategy (zero user interaction):
 *   1. Find the user's last N sent messages (default 50, last 14 days).
 *   2. For each, check if any `message_device_copies` row exists.
 *   3. If none exist AND the local plaintext cache still has the original
 *      message text → re-run `fanoutMessageCopies` with that plaintext.
 *
 * Safe to run repeatedly: `fanoutMessageCopies` now uses upsert with
 * `ignoreDuplicates`, so already-fanned messages are no-ops.
 *
 * Triggered once per app session (debounced) from `App.tsx` once the user
 * is authenticated and their E2EE identity is bootstrapped.
 */
import { supabase } from '@/integrations/supabase/client';
import { loadPlaintext } from '@/lib/crypto/plaintextStore';
import { fanoutMessageCopies } from './multiDeviceFanout';
import { isDeviceIdTemporary } from './currentDevice';

const BACKFILL_LOOKBACK_DAYS = 14;
const BACKFILL_MAX_MESSAGES = 50;
const BACKFILL_MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 min between runs

let lastRunAt = 0;
let inFlight = false;

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
    const { data: sent, error } = await supabase
      .from('messages')
      .select('id, conversation_id, body, created_at')
      .eq('sender_id', userId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(BACKFILL_MAX_MESSAGES);

    if (error || !sent?.length) {
      return { scanned: 0, repaired: 0, skipped: 0 };
    }

    const messageIds = sent.map((m) => m.id);
    const { data: existingCopies } = await supabase
      .from('message_device_copies')
      .select('message_id')
      .in('message_id', messageIds);

    const messagesWithCopies = new Set((existingCopies || []).map((c: any) => c.message_id as string));
    const candidates = sent.filter((m) => !messagesWithCopies.has(m.id));

    let repaired = 0;
    let skipped = 0;

    for (const msg of candidates) {
      try {
        const plaintext = await loadPlaintext(msg.id);
        if (!plaintext) {
          skipped += 1;
          continue;
        }
        const result = await fanoutMessageCopies({
          messageId: msg.id,
          conversationId: msg.conversation_id as string,
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
      console.info('[BACKFILL_FANOUT] repaired missing per-device copies', {
        scanned: sent.length,
        candidates: candidates.length,
        repaired,
        skipped,
      });
    }

    return { scanned: sent.length, repaired, skipped };
  } finally {
    inFlight = false;
  }
}

/**
 * Trigger entry point — fire-and-forget. Idempotent.
 */
export function scheduleBackfillMissingDeviceCopies(userId: string, delayMs = 8000): void {
  if (!userId) return;
  setTimeout(() => {
    void backfillMissingDeviceCopies(userId).catch(() => {});
  }, delayMs);
}
