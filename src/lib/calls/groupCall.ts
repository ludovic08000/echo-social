import { supabase } from '@/integrations/supabase/client';
import { generateCallE2EEKey } from '@/hooks/useCall';
import { createAegisCall, updateAegisCallStatus } from './aegisCallProtocol';

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

export async function startGroupCall(opts: StartGroupCallOptions): Promise<GroupCallStarted> {
  const inviteeIds = Array.from(new Set(opts.inviteeIds));
  if (inviteeIds.length === 0) throw new Error('No invitees');
  if (inviteeIds.length > 7) throw new Error('Max 8 participants (you + 7)');

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const callKey = generateCallE2EEKey();
  const created = await createAegisCall({
    conversationId: opts.conversationId,
    callerId: user.id,
    inviteeIds,
    callType: opts.callType,
    callKey,
  });

  return {
    callId: created.callId,
    roomId: created.roomName,
    callKey,
  };
}

export async function acceptGroupCall(callId: string, _userId: string): Promise<void> {
  await updateAegisCallStatus(callId, 'accepted');
}

export async function declineGroupCall(callId: string, _userId: string): Promise<void> {
  await updateAegisCallStatus(callId, 'declined');
}
