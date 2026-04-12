import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { encryptCallKey, decryptCallKey } from '@/lib/crypto/callKeyEncrypt';

let sharedAudioContext: AudioContext | null = null;
let audioPrimed = false;

function primeAudioForIOS() {
  if (audioPrimed) return;

  const unlock = async () => {
    try {
      if (!sharedAudioContext) {
        sharedAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      if (sharedAudioContext.state === 'suspended') {
        await sharedAudioContext.resume();
      }

      // Play a silent frame once to unlock playback on iOS Safari
      const buffer = sharedAudioContext.createBuffer(1, 1, 22050);
      const source = sharedAudioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(sharedAudioContext.destination);
      source.start(0);

      audioPrimed = true;
      window.removeEventListener('touchstart', unlock);
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    } catch {
      // keep listeners until a successful unlock
    }
  };

  window.addEventListener('touchstart', unlock, { passive: true });
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);
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
  encrypted_call_key?: string;
}

/** Ring tone — plays a looping tone until stopped */
function createRingtone(): { play: () => void; stop: () => void } {
  let audioCtx: AudioContext | null = null;
  let oscillatorA: OscillatorNode | null = null;
  let oscillatorB: OscillatorNode | null = null;
  let gainNode: GainNode | null = null;
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const play = async () => {
    try {
      audioCtx = sharedAudioContext ?? new (window.AudioContext || (window as any).webkitAudioContext)();
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      gainNode = audioCtx.createGain();
      gainNode.connect(audioCtx.destination);
      gainNode.gain.value = 0;

      // iOS-friendly double ring pattern
      const ring = () => {
        if (!audioCtx || !gainNode) return;

        oscillatorA = audioCtx.createOscillator();
        oscillatorB = audioCtx.createOscillator();

        oscillatorA.type = 'sine';
        oscillatorB.type = 'sine';
        oscillatorA.frequency.value = 440;
        oscillatorB.frequency.value = 554;

        oscillatorA.connect(gainNode);
        oscillatorB.connect(gainNode);

        const t0 = audioCtx.currentTime;
        gainNode.gain.cancelScheduledValues(t0);
        gainNode.gain.setValueAtTime(0, t0);
        gainNode.gain.linearRampToValueAtTime(0.22, t0 + 0.02);
        gainNode.gain.linearRampToValueAtTime(0, t0 + 0.35);
        gainNode.gain.setValueAtTime(0, t0 + 0.55);
        gainNode.gain.linearRampToValueAtTime(0.22, t0 + 0.62);
        gainNode.gain.linearRampToValueAtTime(0, t0 + 0.95);

        oscillatorA.start(t0);
        oscillatorB.start(t0);
        oscillatorA.stop(t0 + 1.0);
        oscillatorB.stop(t0 + 1.0);
      };

      ring();
      intervalId = setInterval(ring, 2000);
    } catch {
      // Audio unavailable (or blocked by browser)
    }
  };

  const stop = () => {
    if (intervalId) clearInterval(intervalId);
    try {
      oscillatorA?.stop();
      oscillatorA?.disconnect();
    } catch {}
    try {
      oscillatorB?.stop();
      oscillatorB?.disconnect();
    } catch {}
    try {
      gainNode?.disconnect();
    } catch {}

    oscillatorA = null;
    oscillatorB = null;
    gainNode = null;
    intervalId = null;
  };

  return { play, stop };
}

export function useIncomingCall() {
  const { user } = useAuth();
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const ringtoneRef = useRef(createRingtone());
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Listen for incoming calls via realtime
  useEffect(() => {
    if (!user?.id) return;

    // Required on iOS: unlock audio context after first user interaction
    primeAudioForIOS();

    // Check for existing ringing calls on mount (only recent ones, < 30s old)
    const checkExisting = async () => {
      const thirtySecondsAgo = new Date(Date.now() - 30000).toISOString();
      const { data } = await supabase
        .from('active_calls')
        .select('*')
        .eq('callee_id', user.id)
        .eq('status', 'ringing')
        .gte('created_at', thirtySecondsAgo)
        .order('created_at', { ascending: false })
        .limit(1);

      if (data?.[0]) {
        handleIncomingCall(data[0]);
      }

      // Clean up stale ringing calls (older than 30s)
      await supabase
        .from('active_calls')
        .update({ status: 'cancelled', ended_at: new Date().toISOString() })
        .eq('callee_id', user.id)
        .eq('status', 'ringing')
        .lt('created_at', thirtySecondsAgo);
    };
    checkExisting();

    const channel = supabase
      .channel('incoming-calls')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'active_calls',
          filter: `callee_id=eq.${user.id}`,
        },
        (payload) => {
          if (payload.new && (payload.new as any).status === 'ringing') {
            handleIncomingCall(payload.new as any);
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'active_calls',
          filter: `callee_id=eq.${user.id}`,
        },
        (payload) => {
          const updated = payload.new as any;
          // If caller cancelled
          if (updated.status === 'cancelled' || updated.status === 'ended') {
            ringtoneRef.current.stop();
            setIncomingCall(null);
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      ringtoneRef.current.stop();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [user?.id]);

  const handleIncomingCall = async (call: any) => {
    // Fetch caller profile
    const { data: profile } = await supabase
      .from('profiles')
      .select('name, avatar_url')
      .eq('user_id', call.caller_id)
      .single();

    const incoming: IncomingCall = {
      id: call.id,
      conversation_id: call.conversation_id,
      caller_id: call.caller_id,
      callee_id: call.callee_id,
      call_type: call.call_type || 'audio',
      status: call.status,
      caller_name: profile?.name || 'Utilisateur',
      caller_avatar: profile?.avatar_url,
      e2ee_key: call.e2ee_key
        ? await decryptCallKey(call.e2ee_key, call.conversation_id).catch(() => call.e2ee_key)
        : undefined,
    };

    setIncomingCall(incoming);
    ringtoneRef.current.play();

    // Auto-timeout after 30 seconds
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      declineCall();
    }, 30000);
  };

  const acceptCall = useCallback(async () => {
    if (!incomingCall) return;
    ringtoneRef.current.stop();
    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    await supabase
      .from('active_calls')
      .update({ status: 'answered', answered_at: new Date().toISOString() })
      .eq('id', incomingCall.id);

    const accepted = { ...incomingCall };
    setIncomingCall(null);
    return accepted;
  }, [incomingCall]);

  const declineCall = useCallback(async () => {
    if (!incomingCall) return;
    ringtoneRef.current.stop();
    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    await supabase
      .from('active_calls')
      .update({ status: 'declined', ended_at: new Date().toISOString() })
      .eq('id', incomingCall.id);

    setIncomingCall(null);
  }, [incomingCall]);

  return {
    incomingCall,
    acceptCall,
    declineCall,
  };
}

/** Called by the caller to signal an outgoing call */
export async function signalOutgoingCall(
  conversationId: string,
  callerId: string,
  calleeId: string,
  callType: 'audio' | 'video',
  e2eeKey?: string,
): Promise<string | null> {
  // Encrypt the call key using the conversation's E2EE session key
  const encryptedKey = e2eeKey
    ? await encryptCallKey(e2eeKey, conversationId).catch(() => e2eeKey)
    : undefined;

  const { data, error } = await supabase
    .from('active_calls')
    .insert({
      conversation_id: conversationId,
      caller_id: callerId,
      callee_id: calleeId,
      call_type: callType,
      status: 'ringing',
      ...(encryptedKey ? { e2ee_key: encryptedKey } : {}),
    } as any)
    .select('id')
    .single();

  if (error) {
    console.error('Signal call error:', error);
    return null;
  }
  return data?.id || null;
}

/** Called when call ends to update the record */
export async function endActiveCall(callId: string) {
  await supabase
    .from('active_calls')
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('id', callId);
}
