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
  is_group?: boolean;
}

/** Returned only by acceptCall — includes the decrypted key for immediate use */
export interface AcceptedCall extends IncomingCall {
  decryptedCallKey: string;
}

/** Ring tone — plays a looping tone until stopped */
function createRingtone(): { play: () => void; stop: () => void } {
  let audioCtx: AudioContext | null = null;
  let oscillatorA: OscillatorNode | null = null;
  let oscillatorB: OscillatorNode | null = null;
  let gainNode: GainNode | null = null;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let stopped = true; // Guards against play/stop race condition

  const play = async () => {
    stopped = false;
    try {
      audioCtx = sharedAudioContext ?? new (window.AudioContext || (window as any).webkitAudioContext)();
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      // If stop() was called while we were awaiting resume, bail out
      if (stopped) return;

      gainNode = audioCtx.createGain();
      gainNode.connect(audioCtx.destination);
      gainNode.gain.value = 0;

      const ring = () => {
        if (stopped || !audioCtx || !gainNode) return;

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
    stopped = true;
    if (intervalId) clearInterval(intervalId);
    intervalId = null;
    try { oscillatorA?.stop(); oscillatorA?.disconnect(); } catch {}
    try { oscillatorB?.stop(); oscillatorB?.disconnect(); } catch {}
    try { gainNode?.disconnect(); } catch {}
    oscillatorA = null;
    oscillatorB = null;
    gainNode = null;
    // Do NOT close or null audioCtx — it may be the shared context used by LiveKit
  };

  return { play, stop };
}

/**
 * Call detection state machine:
 *   idle → ringing → (accepted | declined | timed_out)
 * 
 * A call ID is processed ONCE — any duplicate detection (Realtime, backup, poll)
 * for the same ID is silently ignored.
 */
type IncomingCallPhase = 'idle' | 'ringing' | 'connecting' | 'active' | 'ended';

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

  const handledCallIdsRef = useRef<Set<string>>(new Set());
  const activeCallIdRef = useRef<string | null>(null);
  const callPhaseRef = useRef<IncomingCallPhase>('idle');
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const handlingRef = useRef(false);

  // Keep ref in sync with state
  useEffect(() => { incomingCallRef.current = incomingCall; }, [incomingCall]);

  useEffect(() => {
    if (!user?.id) return;

    primeAudioForIOS();
    console.log('[IncomingCall] 🔔 Hook initialized for user', user.id);

    /**
     * Core handler — idempotent per callId.
     * Returns immediately if this callId was already processed.
     */
    const handleIncomingCall = async (call: any) => {
      const callId = call.id;

      if (handledCallIdsRef.current.has(callId)) return;
      if (activeCallIdRef.current === callId) return;
      if (handlingRef.current) return;
      if (callPhaseRef.current !== 'idle') return;

      handlingRef.current = true;
      handledCallIdsRef.current.add(callId);
      activeCallIdRef.current = callId;
      callPhaseRef.current = 'ringing';

      console.info('[IncomingCall] New incoming call:', callId, 'type:', call.call_type);

      try {
        const { data: profile } = await supabase
          .from('profiles')
          .select('name, avatar_url')
          .eq('user_id', call.caller_id)
          .single();

        // Store encrypted key in volatile ref — NEVER in React state
        encryptedCallKeyRef.current = call.encrypted_call_key || null;
        callConversationIdRef.current = call.conversation_id;

        const incoming: IncomingCall = {
          id: callId,
          conversation_id: call.conversation_id,
          caller_id: call.caller_id,
          callee_id: call.callee_id,
          call_type: call.call_type || 'audio',
          status: call.status,
          caller_name: profile?.name || 'Utilisateur',
          caller_avatar: profile?.avatar_url,
          is_group: call.is_group === true,
        };

        setIncomingCall(incoming);
        ringtoneRef.current.play();

        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => {
          declineCallDirect(callId);
        }, 30000);
      } finally {
        handlingRef.current = false;
      }
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
      activeCallIdRef.current = null;
      callPhaseRef.current = 'ended';
      setIncomingCall(null);
      queueMicrotask(() => {
        callPhaseRef.current = 'idle';
      });
    };

    const clearCallState = () => {
      ringtoneRef.current.stop();
      setIncomingCall(null);
      encryptedCallKeyRef.current = null;
      callConversationIdRef.current = null;
      activeCallIdRef.current = null;
      callPhaseRef.current = 'ended';
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      queueMicrotask(() => {
        callPhaseRef.current = 'idle';
      });
    };

    const pollForCalls = async () => {
      // Don't poll if already showing an incoming call
      if (incomingCallRef.current) return;

      try {
        const { data, error } = await supabase.rpc('call_signal', {
          p_action: 'latest_for_callee',
        });

        if (error) {
          // Only log non-routine errors
          if (error.message?.includes('Not authenticated') || error.code === 'PGRST301') {
            await supabase.auth.refreshSession();
          }
          return;
        }

        if (data && (data as any).id) {
          const callData = data as any;
          if (callData.status === 'ringing') {
            // handleIncomingCall is idempotent — safe to call even if already handled
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
    Promise.resolve(supabase.rpc('call_signal', { p_action: 'expire_old_for_callee' })).catch(() => {});

    // Fallback polling every 3 seconds (increased from 2s to reduce noise)
    pollIntervalRef.current = setInterval(pollForCalls, 3000);

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
          if (callData?.status === 'ringing') {
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
            clearCallState();
          }
        }
      )
      // Group calls — sonne aussi quand uid ∈ caller_ids
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'active_calls' },
        (payload) => {
          const callData = payload.new as any;
          if (
            callData?.is_group &&
            callData?.status === 'ringing' &&
            Array.isArray(callData?.caller_ids) &&
            callData.caller_ids.includes(user.id)
          ) {
            handleIncomingCall(callData);
          }
        }
      )
      .subscribe((status) => {
        console.log('[IncomingCall] Realtime status:', status);
      });

    // REMOVED: backup channel was causing duplicate detections.
    // The primary Realtime channel + polling is sufficient.

    return () => {
      supabase.removeChannel(channel);
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      ringtoneRef.current.stop();
      encryptedCallKeyRef.current = null;
      callConversationIdRef.current = null;
      activeCallIdRef.current = null;
      callPhaseRef.current = 'idle';
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
    callPhaseRef.current = 'connecting';

    let decryptedCallKey: string | undefined;
    const encKey = encryptedCallKeyRef.current;
    const convId = callConversationIdRef.current;
    if (!encKey || !convId) {
      encryptedCallKeyRef.current = null;
      callConversationIdRef.current = null;
      activeCallIdRef.current = null;
      setIncomingCall(null);
      callPhaseRef.current = 'ended';
      queueMicrotask(() => {
        callPhaseRef.current = 'idle';
      });
      throw new Error('[CALL_E2EE] Missing encrypted call key payload');
    }

    try {
      // Group calls (D3): the call key is shared in clear via encrypted_call_key
      // (per-recipient wrapping is planned for D4). Skip 1-to-1 decryption.
      if (incomingCall.is_group) {
        decryptedCallKey = encKey;
      } else {
        // Always pass user IDs for fresh session derivation
        const { data: { user: currentUser } } = await supabase.auth.getUser();
        if (!currentUser) throw new Error('Not authenticated');
        const peerId = incomingCall.caller_id;
        decryptedCallKey = await decryptCallKey(encKey, convId, currentUser.id, peerId);
      }
    } catch (decryptError) {
      console.error('[CALL] Aegis call-key decrypt failed:', decryptError);
    }

    if (!decryptedCallKey) {
      await supabase.rpc('call_signal', {
        p_action: 'update_status',
        p_call_id: incomingCall.id,
        p_status: 'declined',
      });
      encryptedCallKeyRef.current = null;
      callConversationIdRef.current = null;
      activeCallIdRef.current = null;
      setIncomingCall(null);
      callPhaseRef.current = 'ended';
      queueMicrotask(() => {
        callPhaseRef.current = 'idle';
      });
      throw new Error('[CALL_E2EE] Unable to decrypt incoming call key');
    }

    await supabase.rpc('call_signal', {
      p_action: 'update_status',
      p_call_id: incomingCall.id,
      p_status: 'answered',
    });

    encryptedCallKeyRef.current = null;
    callConversationIdRef.current = null;

    const accepted: AcceptedCall = { ...incomingCall, decryptedCallKey };
    setIncomingCall(null);
    callPhaseRef.current = 'active';
    return accepted;
  }, [incomingCall]);

  const declineCall = useCallback(async () => {
    if (!incomingCall) return;
    ringtoneRef.current.stop();
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    callPhaseRef.current = 'ended';

    await supabase.rpc('call_signal', {
      p_action: 'update_status',
      p_call_id: incomingCall.id,
      p_status: 'declined',
    });

    encryptedCallKeyRef.current = null;
    callConversationIdRef.current = null;
    activeCallIdRef.current = null;
    setIncomingCall(null);
    queueMicrotask(() => {
      callPhaseRef.current = 'idle';
    });
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
    encryptedKey = await encryptCallKey(callKeyB64, conversationId, callerId, calleeId);
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
