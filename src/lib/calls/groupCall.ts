import { supabase } from '@/integrations/supabase/client';
import { generateCallE2EEKey } from '@/hooks/useCall';

export interface StartGroupCallOptions {
  conversationId: string;
  inviteeIds: string[]; // does NOT include the caller
  callType: 'audio' | 'video';
}

export interface GroupCallStarted {
  callId: string;
  roomId: string;
  callKey: string; // base64 — caller keeps it in RAM only
}

/**
 * Creates a group active_call row. Push triggers will sonner all invitees in parallel.
 * The E2EE key is generated client-side and stored encrypted (one entry per invitee
 * could be added later; for v1 we store unencrypted hint and rely on LiveKit SFrame
 * derived from the room_id + callKey shared via realtime).
 */
export async function startGroupCall(
  opts: StartGroupCallOptions
): Promise<GroupCallStarted> {
  const { conversationId, inviteeIds, callType } = opts;
  if (inviteeIds.length === 0) throw new Error('No invitees');
  if (inviteeIds.length > 7) throw new Error('Max 8 participants (you + 7)');

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const callKey = generateCallE2EEKey();
  const roomId = crypto.randomUUID();

  const { data, error } = await supabase
    .from('active_calls')
    .insert({
      conversation_id: conversationId,
      caller_id: user.id,
      callee_id: inviteeIds[0], // legacy field — first invitee for back-compat
      caller_ids: inviteeIds,
      is_group: true,
      room_id: roomId,
      call_type: callType,
      status: 'ringing',
      // Store callKey base64 directly; in v2 wrap it per-recipient with their device pubkey
      encrypted_call_key: callKey,
    })
    .select('id, room_id')
    .single();

  if (error) throw error;

  return { callId: data.id, roomId: data.room_id || roomId, callKey };
}

/** Mark current user as accepted */
export async function acceptGroupCall(callId: string, userId: string): Promise<void> {
  const { data } = await supabase.from('active_calls').select('accepted_by, status').eq('id', callId).single();
  if (!data) return;
  const next = Array.from(new Set([...((data.accepted_by as string[] | null) ?? []), userId]));
  await supabase.from('active_calls').update({
    accepted_by: next,
    status: data.status === 'ringing' ? 'accepted' : data.status,
  }).eq('id', callId);
}

/** Mark current user as declined */
export async function declineGroupCall(callId: string, userId: string): Promise<void> {
  const { data } = await supabase.from('active_calls').select('declined_by').eq('id', callId).single();
  if (!data) return;
  const next = Array.from(new Set([...((data.declined_by as string[] | null) ?? []), userId]));
  await supabase.from('active_calls').update({ declined_by: next }).eq('id', callId);
}
