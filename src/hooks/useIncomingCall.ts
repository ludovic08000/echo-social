import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { decryptCallKey, encryptCallKey } from '@/lib/crypto/callKeyEncrypt';

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

/**
 * Public-facing incoming call data.
 * SECURITY: NO decrypted key here — the key is decrypted only at accept time
 * and returned directly, never stored in React state.
 */
export interface IncomingCall {
  id: string;
  conversation_id: string;
  caller_id: string;
  callee_id: string;
  call_type: 'audio' | 'video';
  status: string;
  caller_name?: string;
  caller_avatar?: string;
}

/** Returned only by acceptCall — includes the decrypted key for immediate use */
export interface AcceptedCall extends IncomingCall {
  decryptedCallKey?: string;
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
    try { oscillatorA?.stop(); oscillatorA?.disconnect(); } catch {}
    try { oscillatorB?.stop(); oscillatorB?.disconnect(); } catch {}
    try { gainNode?.disconnect(); } catch {}
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

  /**
   * SECURITY: The encrypted call key is stored in a volatile ref,
   * never in React state, and wiped after accept/decline.
   */
  const encryptedCallKeyRef = useRef<string | null>(null);
  const callConversationIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!user?.id) return;

    primeAudioForIOS();

    const checkExisting = async () => {
      const thirtySecondsAgo = new Date(Date.now() - 30000).toISOString();
      const { data } = await supabase
        .from('active_calls')
        .select('id, conversation_id, caller_id, callee_id, call_type, status, encrypted_call_key, created_at')
        .eq('callee_id', user.id)
        .eq('status', 'ringing')
        .gte('created_at', thirtySecondsAgo)
        .order('created_at', { ascending: false })
        .limit(1);

      if (data?.[0]) {
        handleIncomingCall(data[0]);
      }

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
          if (updated.status === 'cancelled' || updated.status === 'ended') {
            ringtoneRef.current.stop();
            setIncomingCall(null);
            encryptedCallKeyRef.current = null;
            callConversationIdRef.current = null;
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      ringtoneRef.current.stop();
      encryptedCallKeyRef.current = null;
      callConversationIdRef.current = null;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [user?.id]);

  const handleIncomingCall = async (call: any) => {
    const { data: profile } = await supabase
      .from('profiles')
      .select('name, avatar_url')
      .eq('user_id', call.caller_id)
      .single();

    // Store encrypted key in volatile ref — NEVER in React state
    encryptedCallKeyRef.current = call.encrypted_call_key || null;
    callConversationIdRef.current = call.conversation_id;

    const incoming: IncomingCall = {
      id: call.id,
      conversation_id: call.conversation_id,
      caller_id: call.caller_id,
      callee_id: call.callee_id,
      call_type: call.call_type || 'audio',
      status: call.status,
      caller_name: profile?.name || 'Utilisateur',
      caller_avatar: profile?.avatar_url,
      // NO key here — zero-access design
    };

    setIncomingCall(incoming);
    ringtoneRef.current.play();

    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      declineCall();
    }, 30000);
  };

  /**
   * Accept the call and decrypt the key at this exact moment.
   * The decrypted key is returned once and never persisted.
   */
  const acceptCall = useCallback(async (): Promise<AcceptedCall | undefined> => {
    if (!incomingCall) return;
    ringtoneRef.current.stop();
    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    await supabase
      .from('active_calls')
      .update({ status: 'answered', answered_at: new Date().toISOString() })
      .eq('id', incomingCall.id);

    // Decrypt call key now — one-shot, then wipe
    let decryptedCallKey: string | undefined;
    const encKey = encryptedCallKeyRef.current;
    const convId = callConversationIdRef.current;
    if (encKey && convId) {
      try {
        decryptedCallKey = await decryptCallKey(encKey, convId);
      } catch (err) {
        console.warn('[IncomingCall] Failed to decrypt call key:', err);
        // Call will proceed without E2EE media encryption
      }
    }

    // Wipe refs immediately
    encryptedCallKeyRef.current = null;
    callConversationIdRef.current = null;

    const accepted: AcceptedCall = { ...incomingCall, decryptedCallKey };
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

    // Wipe refs
    encryptedCallKeyRef.current = null;
    callConversationIdRef.current = null;
    setIncomingCall(null);
  }, [incomingCall]);

  return {
    incomingCall,
    acceptCall,
    declineCall,
  };
}

/**
 * Signal an outgoing call.
 * The callKey is encrypted BEFORE being sent to the database.
 * Only `encrypted_call_key` is stored — the server never sees the raw key.
 */
export async function signalOutgoingCall(
  conversationId: string,
  callerId: string,
  calleeId: string,
  callType: 'audio' | 'video',
  callKeyB64?: string,
): Promise<string | null> {
  let encryptedKey: string | undefined;

  if (callKeyB64) {
    try {
      encryptedKey = await encryptCallKey(callKeyB64, conversationId);
    } catch {
      // No E2EE session — call proceeds without encrypted key transport
      console.warn('[SignalCall] Could not encrypt call key — no E2EE session');
    }
  }

  const { data, error } = await supabase
    .from('active_calls')
    .insert({
      conversation_id: conversationId,
      caller_id: callerId,
      callee_id: calleeId,
      call_type: callType,
      status: 'ringing',
      ...(encryptedKey ? { encrypted_call_key: encryptedKey } : {}),
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
