/**
 * Multi-device fan-out — distributes a sent message as additional, per-device
 * encrypted copies in `message_device_copies`.
 *
 * Strictly additive. The original `messages` row (encrypted with the per-conv
 * Double Ratchet) is the source of truth for the primary device.
 * Copies allow the SAME user reading on another device to see the plaintext,
 * and the recipient's other devices to read the message even if their ratchet
 * state is not yet set up.
 *
 * Failure of fan-out is non-fatal: the message is still delivered via the
 * legacy single-device ratchet path.
 */
import { supabase } from '@/integrations/supabase/client';
import { getCurrentDeviceId } from './currentDevice';
import { wrapPlaintextForDevice } from './deviceWrap';

interface FanoutInput {
  messageId: string;
  conversationId: string;
  senderUserId: string;
  plaintext: string;
}

interface ActiveDevice {
  user_id: string;
  device_id: string;
  device_public_key: string;
}

export async function fanoutMessageCopies(input: FanoutInput): Promise<{ inserted: number; multiDevice: boolean }> {
  const senderDeviceId = getCurrentDeviceId();

  // 1. Get all participants of the conversation
  const { data: participants } = await supabase
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', input.conversationId);

  if (!participants?.length) return { inserted: 0, multiDevice: false };

  const userIds = participants.map(p => p.user_id);

  // 2. For each participant, list active devices (via SECURITY DEFINER RPC)
  const deviceLists = await Promise.all(
    userIds.map(async (uid) => {
      try {
        const { data } = await supabase.rpc('list_active_devices_for_user', { p_user_id: uid });
        return (data || []).map((d: any) => ({
          user_id: uid,
          device_id: d.device_id as string,
          device_public_key: d.device_public_key as string,
        })) as ActiveDevice[];
      } catch {
        return [] as ActiveDevice[];
      }
    }),
  );

  const allDevices = deviceLists.flat();

  // Decide if multi-device is in play: more than 1 device across participants
  // (the sender's own device alone doesn't count).
  const multiDevice = allDevices.filter(d =>
    !(d.user_id === input.senderUserId && d.device_id === senderDeviceId)
  ).length > 0;

  if (!multiDevice) return { inserted: 0, multiDevice: false };

  // 3. Wrap plaintext per-device and insert copies (skip current sender device —
  // the ratchet body in `messages` already serves it).
  const rows: Array<Record<string, string>> = [];
  for (const dev of allDevices) {
    if (dev.user_id === input.senderUserId && dev.device_id === senderDeviceId) continue;
    if (!dev.device_public_key) continue;
    try {
      const wrapped = await wrapPlaintextForDevice(
        input.plaintext,
        input.senderUserId,
        dev.device_public_key,
        dev.device_id,
      );
      rows.push({
        message_id: input.messageId,
        recipient_user_id: dev.user_id,
        recipient_device_id: dev.device_id,
        sender_user_id: input.senderUserId,
        sender_device_id: senderDeviceId,
        encrypted_body: wrapped,
      });
    } catch (e) {
      // Skip this device — best-effort fan-out
      console.warn('[FANOUT] wrap failed for device', dev.device_id, e);
    }
  }

  if (!rows.length) return { inserted: 0, multiDevice: true };

  const { error } = await supabase.from('message_device_copies').insert(rows as any);
  if (error) {
    console.warn('[FANOUT] insert failed', error.message);
    return { inserted: 0, multiDevice: true };
  }

  // 4. Tag the parent message as multi-device for downstream readers
  await supabase
    .from('messages')
    .update({ body_kind: 'multi_device' } as any)
    .eq('id', input.messageId);

  return { inserted: rows.length, multiDevice: true };
}

/**
 * Try to read a message via the per-device copy table.
 * Returns plaintext or null. Used by DecryptedMessageBody as fallback when the
 * ratchet decrypt fails (typical case: secondary device).
 */
export async function tryReadDeviceCopy(messageId: string): Promise<string | null> {
  const myDeviceId = getCurrentDeviceId();
  try {
    const { data } = await supabase.rpc('get_device_copy_for_message', {
      p_message_id: messageId,
      p_device_id: myDeviceId,
    });
    if (!data || data.length === 0) return null;
    const row = data[0] as { encrypted_body: string; sender_user_id: string; sender_device_id: string };

    // Need sender device public key to derive the same shared secret.
    const { data: senderDevices } = await supabase.rpc('list_active_devices_for_user', {
      p_user_id: row.sender_user_id,
    });
    const senderDev = (senderDevices || []).find((d: any) => d.device_id === row.sender_device_id);
    if (!senderDev?.device_public_key) return null;

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;

    const { unwrapPlaintextForDevice } = await import('./deviceWrap');
    return await unwrapPlaintextForDevice(
      row.encrypted_body,
      user.id,
      senderDev.device_public_key,
      myDeviceId,
    );
  } catch (e) {
    console.warn('[FANOUT] device-copy read failed', e);
    return null;
  }
}
