import { supabase } from '@/integrations/supabase/client';
import { generateCallE2EEKey } from '@/hooks/useCall';
import { startSecureCall } from '@/lib/aegis/calls';

export interface StartGroupCallOptions {
  conversationId: string;
  inviteeIds: string[];
  callType: 'audio' | 'video';
}

export interface GroupCallStarted {
  callId: string;
  roomId: string;
  callKey: string;
}

export async function startGroupCall(
  opts: StartGroupCallOptions,
): Promise<GroupCallStarted> {
  const inviteeIds = [...new Set(opts.inviteeIds.filter(Boolean))];
  if (inviteeIds.length === 0) throw new Error('No invitees');
  if (inviteeIds.length > 7) throw new Error('Max 8 participants (you + 7)');

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');
  const callKey = generateCallE2EEKey();
  const started = await startSecureCall({
    conversationId: opts.conversationId,
    callerUserId: user.id,
    inviteeIds,
    callType: opts.callType,
    callKeyB64: callKey,
    isGroup: true,
  });
  return { ...started, callKey };
}

export async function acceptGroupCall(callId: string, userId: string): Promise<void> {
  const { data } = await supabase
    .from('active_calls')
    .select('accepted_by, status')
    .eq('id', callId)
    .single();
  if (!data) return;
  const next = Array.from(new Set([...((data.accepted_by as string[] | null) ?? []), userId]));
  await supabase.from('active_calls').update({
    accepted_by: next,
    status: data.status === 'ringing' ? 'accepted' : data.status,
  }).eq('id', callId);
}

export async function declineGroupCall(callId: string, userId: string): Promise<void> {
  const { data } = await supabase
    .from('active_calls')
    .select('declined_by')
    .eq('id', callId)
    .single();
  if (!data) return;
  const next = Array.from(new Set([...((data.declined_by as string[] | null) ?? []), userId]));
  await supabase.from('active_calls').update({ declined_by: next }).eq('id', callId);
}
