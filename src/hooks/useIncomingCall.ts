import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import {
  createAegisCall,
  latestAegisCallForCurrentDevice,
  loadCurrentDeviceCallInvitation,
  updateAegisCallStatus,
} from '@/lib/calls/aegisCallProtocol';
import { AegisCallError, normalizeAegisCallError, traceCall } from '@/lib/calls/callDiagnostics';
import { isAegisCallingEnabled } from '@/lib/calls/callPolicy';

let sharedAudioContext: AudioContext | null = null;

function createRingtone(): { play: () => void; stop: () => void } {
  let context: AudioContext | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let stopped = true;

  const pulse = () => {
    if (stopped || !context) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 480;
    gain.gain.setValueAtTime(0, context.currentTime);
    gain.gain.linearRampToValueAtTime(0.18, context.currentTime + 0.02);
    gain.gain.linearRampToValueAtTime(0, context.currentTime + 0.42);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.45);
  };

  return {
    play: () => {
      stopped = false;
      try {
        const legacyWindow = window as typeof window & { webkitAudioContext?: typeof AudioContext };
        const AudioContextConstructor = window.AudioContext ?? legacyWindow.webkitAudioContext;
        if (!AudioContextConstructor) return;
        context = sharedAudioContext ?? new AudioContextConstructor();
        sharedAudioContext = context;
        void context.resume().then(() => {
          if (stopped) return;
          pulse();
          interval = setInterval(pulse, 1800);
        });
      } catch {
        // Incoming-call UI remains available when audio playback is blocked.
      }
    },
    stop: () => {
      stopped = true;
      if (interval) clearInterval(interval);
      interval = null;
    },
  };
}

export interface IncomingCall {
  id: string;
  conversation_id: string;
  caller_id: string;
  callee_id: string;
  call_type: 'audio' | 'video';
  status: string;
  caller_name?: string;
  caller_avatar?: string;
  is_group?: boolean;
  room_name?: string;
}

export interface AcceptedCall extends IncomingCall {
  decryptedCallKey: string;
}

type IncomingCallPhase = 'idle' | 'ringing' | 'connecting' | 'active' | 'ended';

export function useIncomingCall() {
  const { user } = useAuth();
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const incomingCallRef = useRef<IncomingCall | null>(null);
  const phaseRef = useRef<IncomingCallPhase>('idle');
  const handledCallIdsRef = useRef(new Set<string>());
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ringtoneRef = useRef(createRingtone());

  useEffect(() => {
    incomingCallRef.current = incomingCall;
  }, [incomingCall]);

  const clearLocalCall = useCallback(() => {
    ringtoneRef.current.stop();
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    setIncomingCall(null);
    phaseRef.current = 'ended';
    queueMicrotask(() => {
      phaseRef.current = 'idle';
    });
  }, []);

  const declineById = useCallback(async (callId: string) => {
    try {
      await updateAegisCallStatus(callId, 'declined');
    } finally {
      clearLocalCall();
    }
  }, [clearLocalCall]);

  useEffect(() => {
    if (!user?.id || !isAegisCallingEnabled()) return;
    let cancelled = false;
    const ringtone = ringtoneRef.current;

    const present = async (row: Record<string, unknown>) => {
      const callId = typeof row.id === 'string' ? row.id : '';
      const conversationId = typeof row.conversation_id === 'string' ? row.conversation_id : '';
      const callerId = typeof row.caller_id === 'string' ? row.caller_id : '';
      if (!callId || !conversationId || !callerId || cancelled || incomingCallRef.current || phaseRef.current !== 'idle') return;
      if (handledCallIdsRef.current.has(callId)) return;
      handledCallIdsRef.current.add(callId);
      phaseRef.current = 'ringing';

      const { data: profile } = await supabase
        .from('profiles')
        .select('name, avatar_url')
        .eq('user_id', callerId)
        .maybeSingle();
      if (cancelled) return;

      const next: IncomingCall = {
        id: callId,
        conversation_id: conversationId,
        caller_id: callerId,
        callee_id: typeof row.callee_id === 'string' ? row.callee_id : user.id,
        call_type: row.call_type === 'video' ? 'video' : 'audio',
        status: typeof row.status === 'string' ? row.status : 'ringing',
        caller_name: profile?.name || 'Utilisateur',
        caller_avatar: profile?.avatar_url || undefined,
        is_group: row.is_group === true,
        room_name: typeof row.room_name === 'string' ? row.room_name : `call-${callId}`,
      };
      setIncomingCall(next);
      traceCall({
        direction: 'incoming', stage: 'ringing', outcome: 'ok', callId,
        conversationId: next.conversation_id,
      });
      ringtone.play();
      timeoutRef.current = setTimeout(() => {
        void declineById(callId);
      }, 30_000);
    };

    const poll = async () => {
      if (cancelled || incomingCallRef.current || phaseRef.current !== 'idle') return;
      try {
        const row = await latestAegisCallForCurrentDevice();
        if (row) await present(row);
      } catch (error) {
        const normalized = normalizeAegisCallError(error, 'CALL_SERVICE_UNAVAILABLE');
        traceCall({ direction: 'incoming', stage: 'invitation_poll', outcome: 'error', errorCode: normalized.code });
      }
    };

    void poll();
    pollRef.current = setInterval(() => void poll(), 3_000);

    const channel = supabase
      .channel(`aegis-call-invitations-${user.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'aegis_call_invitations', filter: `recipient_user_id=eq.${user.id}` },
        () => void poll(),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'active_calls' },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          if (incomingCallRef.current?.id !== row.id) return;
          if (['ended', 'cancelled', 'declined'].includes(String(row.status))) clearLocalCall();
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      ringtone.stop();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      void supabase.removeChannel(channel);
      phaseRef.current = 'idle';
    };
  }, [user?.id, clearLocalCall, declineById]);

  const acceptCall = useCallback(async (): Promise<AcceptedCall | undefined> => {
    if (!incomingCall) return;
    ringtoneRef.current.stop();
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    phaseRef.current = 'connecting';
    const startedAt = Date.now();
    traceCall({
      direction: 'incoming', stage: 'accept', outcome: 'start', callId: incomingCall.id,
      conversationId: incomingCall.conversation_id,
    });

    try {
      const opened = await loadCurrentDeviceCallInvitation(incomingCall.id);
      if (
        opened.conversationId !== incomingCall.conversation_id ||
        opened.callerId !== incomingCall.caller_id ||
        opened.callType !== incomingCall.call_type
      ) {
        throw new AegisCallError('CALL_INVITATION_INVALID');
      }
      await updateAegisCallStatus(incomingCall.id, 'accepted');
      const accepted: AcceptedCall = {
        ...incomingCall,
        room_name: opened.roomName,
        decryptedCallKey: opened.callKey,
      };
      setIncomingCall(null);
      phaseRef.current = 'active';
      traceCall({
        direction: 'incoming', stage: 'accept', outcome: 'ok', callId: incomingCall.id,
        conversationId: incomingCall.conversation_id, elapsedMs: Date.now() - startedAt,
      });
      return accepted;
    } catch (error) {
      const normalized = normalizeAegisCallError(error, 'CALL_INVITATION_INVALID');
      traceCall({
        direction: 'incoming', stage: 'accept', outcome: 'error', callId: incomingCall.id,
        conversationId: incomingCall.conversation_id, elapsedMs: Date.now() - startedAt,
        errorCode: normalized.code,
      });
      await updateAegisCallStatus(incomingCall.id, 'declined').catch(() => undefined);
      clearLocalCall();
      throw normalized;
    }
  }, [incomingCall, clearLocalCall]);

  const declineCall = useCallback(async () => {
    if (!incomingCall) return;
    await declineById(incomingCall.id);
  }, [incomingCall, declineById]);

  return { incomingCall, acceptCall, declineCall };
}

export async function signalOutgoingCall(
  conversationId: string,
  callerId: string,
  calleeId: string,
  callType: 'audio' | 'video',
  callKey: string,
): Promise<string | null> {
  const created = await createAegisCall({
    conversationId,
    callerId,
    inviteeIds: [calleeId],
    callType,
    callKey,
  });
  return created.callId;
}

export async function endActiveCall(callId: string): Promise<void> {
  await updateAegisCallStatus(callId, 'ended');
}
