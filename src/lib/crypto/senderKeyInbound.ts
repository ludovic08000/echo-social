/**
 * Sender Keys inbound consumer.
 *
 * Pulls SKDM rows from `sender_key_distribution` addressed to this user/device,
 * decrypts them via the existing pairwise transports (Double Ratchet → X3DH →
 * deviceWrap fallback — same router as `tryReadDeviceCopy`), then installs the
 * resulting chain via `installSKDM`. Once installed, marks the row as delivered
 * so it isn't re-processed.
 *
 * Two trigger surfaces:
 *   • `catchUpSenderKeyDistribution()` — one-shot poll (called on app boot,
 *     conversation open, key recovery completion).
 *   • `subscribeSenderKeyDistribution()` — realtime INSERT subscription, so
 *     a freshly opted-in conversation receives the SKDM with no manual reload.
 *
 * Idempotent: every row is only processed once thanks to the `delivered` flag
 * (server-side default false). If decrypt fails (out-of-order pairwise state,
 * peer SPK rotated, etc.) we leave `delivered=false` so the next poll retries.
 */
import { supabase } from '@/integrations/supabase/client';
import { getCurrentDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';
import { tryDecryptDeviceTargetedBody } from '@/lib/messaging/multiDeviceFanout';
import { installSKDM } from './senderKeySession';
import { isSenderKeyWire } from './senderKeys';

interface SkdmRow {
  id: string;
  conversation_id: string;
  sender_user_id: string;
  sender_device_id: string;
  recipient_user_id: string;
  recipient_device_id: string;
  encrypted_skdm: string;
}

const inflight = new Set<string>();
const catchUpInflight = new Map<string, Promise<{ processed: number; installed: number }>>();
const activeSubscriptions = new Map<string, { refs: number; unsubscribe: () => void }>();

function inboxKey(userId: string, deviceId: string) {
  return `${userId}:${deviceId}`;
}

async function processRow(row: SkdmRow, recipientUserId: string): Promise<boolean> {
  if (inflight.has(row.id)) return false;
  inflight.add(row.id);
  try {
    const myDeviceId = getCurrentDeviceId();
    // The SKDM was wrapped against the device id captured at fan-out time;
    // pass the row's recipient_device_id so iOS-restored installs (whose
    // device id has rotated) still decrypt via the multi-candidate path.
    const targetDeviceId = row.recipient_device_id || myDeviceId;
    const plaintext = await tryDecryptDeviceTargetedBody(
      {
        encrypted_body: row.encrypted_skdm,
        sender_user_id: row.sender_user_id,
        sender_device_id: row.sender_device_id,
      },
      recipientUserId,
      targetDeviceId,
    );
    if (!plaintext) {
      // Pairwise not ready yet — leave row pending; next poll retries.
      return false;
    }

    // Defensive: a malformed payload shouldn't be marked delivered. installSKDM
    // returns null on parse failure (not an SKDM/v1 envelope).
    const installed = await installSKDM(plaintext);
    if (!installed) {
      console.warn('[SK_INBOUND] payload decrypted but not an SKDM — skipping', { id: row.id });
      return false;
    }

    // Detection sanity: chain installed, mark delivered so we don't reprocess.
    void isSenderKeyWire; // keep import for future inbound buffered-decrypt hook
    const { error } = await supabase
      .from('sender_key_distribution')
      .update({ delivered: true } as any)
      .eq('id', row.id);
    if (error) {
      console.warn('[SK_INBOUND] mark delivered failed', { id: row.id, error });
    }
    return true;
  } catch (e) {
    console.warn('[SK_INBOUND] processRow failed', { id: row.id, e });
    return false;
  } finally {
    inflight.delete(row.id);
  }
}

/**
 * One-shot poll: fetch every undelivered SKDM addressed to this device,
 * decrypt and install. Bounded fetch (200 rows) — schedule again if more.
 */
export async function catchUpSenderKeyDistribution(userId: string): Promise<{
  processed: number;
  installed: number;
}> {
  if (!userId) return { processed: 0, installed: 0 };
  if (isDeviceIdTemporary()) return { processed: 0, installed: 0 };

  const myDeviceId = getCurrentDeviceId();
  const key = inboxKey(userId, myDeviceId);
  const existing = catchUpInflight.get(key);
  if (existing) return existing;

  const task = (async () => {
    const { data, error } = await supabase
      .from('sender_key_distribution')
      .select('id, conversation_id, sender_user_id, sender_device_id, recipient_user_id, recipient_device_id, encrypted_skdm')
      .eq('recipient_user_id', userId)
      .eq('recipient_device_id', myDeviceId)
      .eq('delivered', false)
      .order('created_at', { ascending: true })
      .limit(200);

    if (error || !data?.length) return { processed: 0, installed: 0 };

    let installed = 0;
    for (const row of data as SkdmRow[]) {
      const ok = await processRow(row, userId);
      if (ok) installed++;
    }
    return { processed: data.length, installed };
  })().finally(() => {
    catchUpInflight.delete(key);
  });

  catchUpInflight.set(key, task);
  return task;
}

/**
 * Realtime subscription: install SKDMs as soon as they arrive. Returns an
 * unsubscribe function. Call once at app boot after auth resolves.
 */
export function subscribeSenderKeyDistribution(userId: string): () => void {
  if (!userId) return () => {};
  if (isDeviceIdTemporary()) return () => {};

  const myDeviceId = getCurrentDeviceId();
  const key = inboxKey(userId, myDeviceId);
  const existing = activeSubscriptions.get(key);
  if (existing) {
    existing.refs += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      existing.refs -= 1;
      if (existing.refs <= 0) {
        existing.unsubscribe();
        activeSubscriptions.delete(key);
      }
    };
  }

  const channel = supabase
    .channel(`skdm-inbox-${userId}-${myDeviceId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'sender_key_distribution',
        filter: `recipient_user_id=eq.${userId}`,
      },
      (payload) => {
        const row = payload.new as SkdmRow;
        if (!row?.id) return;
        // Best-effort device match: realtime can't filter on two columns.
        if (isDeviceIdTemporary()) return;
        const currentDeviceId = getCurrentDeviceId();
        if (row.recipient_device_id && row.recipient_device_id !== currentDeviceId) return;
        void processRow(row, userId);
      },
    )
    .subscribe();

  const entry = {
    refs: 1,
    unsubscribe: () => {
      try {
        supabase.removeChannel(channel);
      } catch {
        // ignore — channel may already be torn down on hot reload
      }
    },
  };
  activeSubscriptions.set(key, entry);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    try {
      entry.unsubscribe();
    } catch {
      // ignore — channel may already be torn down on hot reload
    }
    activeSubscriptions.delete(key);
  };
}
