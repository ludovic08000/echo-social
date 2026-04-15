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
  const incomingCallRef = useRef<IncomingCall | null>(null);
  const ringtoneRef = useRef(createRingtone());
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * SECURITY: The encrypted call key is stored in a volatile ref,
   * never in React state, and wiped after accept/decline.
   */
  const encryptedCallKeyRef = useRef<string | null>(null);
  const callConversationIdRef = useRef<string | null>(null);

  // Track which call IDs we've already handled to avoid duplicate rings
  const handledCallIdsRef = useRef<Set<string>>(new Set());
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Keep ref in sync with state
  useEffect(() => { incomingCallRef.current = incomingCall; }, [incomingCall]);

  useEffect(() => {
    if (!user?.id) return;

    primeAudioForIOS();
    console.log('[IncomingCall] 🔔 Hook initialized for user', user.id);

    const handleIncomingCall = async (call: any) => {
      console.log('[IncomingCall] 📞 Incoming call detected:', call.id, 'type:', call.call_type);

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
      };

      setIncomingCall(incoming);
      ringtoneRef.current.play();

      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        declineCallDirect(incoming.id);
      }, 30000);
    };

    const declineCallDirect = async (callId: string) => {
      ringtoneRef.current.stop();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      await supabase.rpc('call_signal', {
        p_action: 'update_status',
        p_call_id: callId,
        p_status: 'declined',
      });
      encryptedCallKeyRef.current = null;
      callConversationIdRef.current = null;
      setIncomingCall(null);
    };

    const pollForCalls = async () => {
      // Don't poll if already showing an incoming call
      if (incomingCallRef.current) return;

      try {
        const { data, error } = await supabase.rpc('call_signal', {
          p_action: 'latest_for_callee',
        });

        if (error) {
          console.warn('[IncomingCall] ⚠️ Poll error:', error.message);
          // If auth expired, try to refresh
          if (error.message?.includes('Not authenticated') || error.code === 'PGRST301') {
            console.log('[IncomingCall] 🔄 Refreshing session...');
            await supabase.auth.refreshSession();
          }
          return;
        }

        if (data && (data as any).id) {
          const callData = data as any;
          console.log('[IncomingCall] 📡 Poll found call:', callData.id, 'status:', callData.status);
          if (callData.status === 'ringing' && !handledCallIdsRef.current.has(callData.id)) {
            handledCallIdsRef.current.add(callData.id);
            handleIncomingCall(callData);
          }
        }
      } catch (err) {
        console.error('[IncomingCall] ❌ Poll exception:', err);
      }
    };

    // Ensure fresh auth before starting
    supabase.auth.refreshSession().then(() => {
      console.log('[IncomingCall] ✅ Session refreshed, starting detection');
    }).catch(() => {});

    // Initial check
    pollForCalls();

    // Expire old calls once
    supabase.rpc('call_signal', { p_action: 'expire_old_for_callee' }).then(() => {}).catch(() => {});

    // Fallback polling every 2 seconds — catches calls even if Realtime fails
    pollIntervalRef.current = setInterval(pollForCalls, 2000);

    // Realtime channel for instant notification (primary path)
    const channel = supabase
      .channel(`incoming-calls-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'active_calls',
          filter: `callee_id=eq.${user.id}`,
        },
        (payload) => {
          const callData = payload.new as any;
          console.log('[IncomingCall] ⚡ Realtime INSERT:', callData?.id, 'status:', callData?.status);
          if (callData?.status === 'ringing' && !handledCallIdsRef.current.has(callData.id)) {
            handledCallIdsRef.current.add(callData.id);
            handleIncomingCall(callData);
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
          if (updated.status === 'cancelled' || updated.status === 'ended' || updated.status === 'declined') {
            ringtoneRef.current.stop();
            setIncomingCall(null);
            encryptedCallKeyRef.current = null;
            callConversationIdRef.current = null;
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
          }
        }
      )
      .subscribe((status) => {
        console.log('[IncomingCall] Realtime status:', status);
      });

    // Also listen on the notifications table for call notifications as a backup
    const notifChannel = supabase
      .channel(`call-notif-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          const notif = payload.new as any;
          if (notif?.type === 'incoming_call') {
            console.log('[IncomingCall] 🔔 Notification backup triggered, forcing poll');
            pollForCalls();
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      supabase.removeChannel(notifChannel);
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      ringtoneRef.current.stop();
      encryptedCallKeyRef.current = null;
      callConversationIdRef.current = null;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [user?.id]);

  /**
   * Accept the call and decrypt the key at this exact moment.
   * The decrypted key is returned once and never persisted.
   */
  const acceptCall = useCallback(async (): Promise<AcceptedCall | undefined> => {
    if (!incomingCall) return;
    ringtoneRef.current.stop();
    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    await supabase.rpc('call_signal', {
      p_action: 'update_status',
      p_call_id: incomingCall.id,
      p_status: 'answered',
    });

    // Decrypt call key now — one-shot, then wipe
    let decryptedCallKey: string | undefined;
    const encKey = encryptedCallKeyRef.current;
    const convId = callConversationIdRef.current;
    if (encKey && convId) {
      try {
        decryptedCallKey = await decryptCallKey(encKey, convId);
      } catch (err) {
        console.warn('[IncomingCall] Failed to decrypt call key:', err);
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

    await supabase.rpc('call_signal', {
      p_action: 'update_status',
      p_call_id: incomingCall.id,
      p_status: 'declined',
    });

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
      console.warn('[SignalCall] Could not encrypt call key — no E2EE session');
    }
  }

  const { data, error } = await supabase.rpc('call_signal', {
    p_action: 'create',
    p_conversation_id: conversationId,
    p_caller_id: callerId,
    p_callee_id: calleeId,
    p_call_type: callType,
    p_encrypted_call_key: encryptedKey ?? null,
  });

  if (error) {
    console.error('Signal call error:', error);
    return null;
  }

  const callId = (data as { id?: string } | null)?.id || null;

  return callId;
}

/** Called when call ends to update the record */
export async function endActiveCall(callId: string) {
  await supabase.rpc('call_signal', {
    p_action: 'update_status',
    p_call_id: callId,
    p_status: 'ended',
  });
}
