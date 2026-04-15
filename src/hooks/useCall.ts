import { useState, useCallback, useRef, useEffect } from 'react';
import { Room, RoomEvent, Track, ExternalE2EEKeyProvider, isE2EESupported } from 'livekit-client';
import { getLiveKitToken } from '@/lib/livekit';
import { requestMediaPermissions, acquireWakeLock, releaseWakeLock } from '@/lib/platformPermissions';
import { toast } from 'sonner';

export type CallType = 'audio' | 'video';

/**
 * Call phase state machine:
 *   idle → connecting → connected → ending → idle
 * 
 * Only valid transitions:
 *   idle → connecting        (startCall)
 *   connecting → connected   (remote participant joins)
 *   connecting → ending      (timeout, decline, error, manual end)
 *   connected → ending       (manual end, remote leaves, error)
 *   ending → idle            (cleanup complete)
 */
export type CallPhase = 'idle' | 'connecting' | 'connected' | 'ending';

// Legacy alias
export type CallState = CallPhase;

export interface CallEndInfo {
  type: CallType;
  duration: number;
  wasMissed: boolean;
}

interface UseCallOptions {
  onCallEnded?: (info: CallEndInfo) => void;
}

/** Generate a random 32-byte key and return as base64 */
export function generateCallE2EEKey(): string {
  const key = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...key));
}

/** Decode a base64 key back to Uint8Array */
function decodeE2EEKey(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export function useCall(options?: UseCallOptions) {
  const [callState, setCallState] = useState<CallPhase>('idle');
  const [callType, setCallType] = useState<CallType>('audio');
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [duration, setDuration] = useState(0);
  const [isE2eeActive, setIsE2eeActive] = useState(false);

  const roomRef = useRef<Room | null>(null);
  const localVideoRef = useRef<HTMLDivElement | null>(null);
  const remoteVideoRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const noAnswerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stable refs for state (avoid stale closures in event handlers)
  const phaseRef = useRef<CallPhase>('idle');
  const durationRef = useRef(0);
  const callTypeRef = useRef<CallType>('audio');
  const hadRemoteRef = useRef(false);

  // Guards
  const connectingRef = useRef(false);    // prevents double startCall
  const endingRef = useRef(false);        // prevents double safeDisconnect

  // Stabilize callback ref
  const onCallEndedRef = useRef(options?.onCallEnded);
  useEffect(() => { onCallEndedRef.current = options?.onCallEnded; });

  // Keep refs in sync with state
  useEffect(() => { phaseRef.current = callState; }, [callState]);
  useEffect(() => { durationRef.current = duration; }, [duration]);
  useEffect(() => { callTypeRef.current = callType; }, [callType]);

  // Duration timer — only runs when connected
  useEffect(() => {
    if (callState === 'connected') {
      timerRef.current = setInterval(() => setDuration(d => d + 1), 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [callState]);

  // ═══════════════════════════════════════════════════════════════════
  // CENTRALIZED DISCONNECT — ALL disconnect paths go through here
  // ═══════════════════════════════════════════════════════════════════
  const safeDisconnect = useCallback((reason: string) => {
    // Idempotent: ignore if already ending or idle
    if (endingRef.current) {
      console.debug(`[CALL] safeDisconnect ignored (already ending), reason: ${reason}`);
      return;
    }
    if (phaseRef.current === 'idle') {
      console.debug(`[CALL] safeDisconnect ignored (idle), reason: ${reason}`);
      return;
    }

    endingRef.current = true;
    const wasMissed = phaseRef.current !== 'connected';
    const endDuration = durationRef.current;
    const endType = callTypeRef.current;

    console.info(`[CALL] ending call — reason: ${reason}, phase: ${phaseRef.current}, duration: ${endDuration}s`);

    // 1. Cancel all timers
    if (noAnswerTimeoutRef.current) {
      clearTimeout(noAnswerTimeoutRef.current);
      noAnswerTimeoutRef.current = null;
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    // 2. Disconnect room (will fire RoomEvent.Disconnected, but endingRef prevents re-entry)
    if (roomRef.current) {
      try {
        roomRef.current.disconnect();
      } catch (e) {
        console.warn('[CALL] room.disconnect() error:', e);
      }
      roomRef.current = null;
    }

    // 3. Cleanup DOM
    if (localVideoRef.current) localVideoRef.current.innerHTML = '';
    if (remoteVideoRef.current) remoteVideoRef.current.innerHTML = '';

    // 4. Reset state
    setCallState('idle');
    setDuration(0);
    setIsE2eeActive(false);
    setIsMuted(false);
    setIsCameraOff(false);
    connectingRef.current = false;
    hadRemoteRef.current = false;

    // 5. Release wake lock
    releaseWakeLock();

    // 6. Fire callback
    onCallEndedRef.current?.({ type: endType, duration: endDuration, wasMissed });

    // 7. Reset ending guard (after all synchronous work is done)
    // Use microtask to ensure RoomEvent.Disconnected handler sees endingRef=true
    queueMicrotask(() => {
      endingRef.current = false;
    });
  }, []);

  // ═══════════════════════════════════════════════════════════════════
  // START CALL
  // ═══════════════════════════════════════════════════════════════════
  const startCall = useCallback(async (conversationId: string, type: CallType, e2eeKeyB64?: string) => {
    // Guard: prevent double-init
    if (connectingRef.current) {
      console.warn('[CALL] startCall ignored — connection already in progress');
      return;
    }
    if (roomRef.current) {
      console.warn('[CALL] startCall ignored — room already exists');
      return;
    }
    if (phaseRef.current !== 'idle') {
      console.warn(`[CALL] startCall ignored — phase is ${phaseRef.current}`);
      return;
    }

    connectingRef.current = true;
    endingRef.current = false;

    console.info(`[CALL] starting ${type} call for conversation ${conversationId}`);

    // Request permissions
    const perms = await requestMediaPermissions({
      audio: true,
      video: type === 'video',
    });

    if (!perms.granted) {
      connectingRef.current = false;
      toast.error(perms.error || "Impossible d'accéder au micro/caméra");
      return;
    }

    setCallType(type);
    setCallState('connecting');
    setDuration(0);
    setIsMuted(false);
    setIsCameraOff(false);
    setIsE2eeActive(false);
    hadRemoteRef.current = false;

    try {
      await acquireWakeLock();

      const roomName = `call-${conversationId}`;
      const { token, url } = await getLiveKitToken(roomName, true);

      // Setup E2EE if supported
      let e2eeKeyProvider: ExternalE2EEKeyProvider | undefined;
      let e2eeWorker: Worker | undefined;
      const canE2EE = e2eeKeyB64 && isE2EESupported();

      if (canE2EE) {
        try {
          e2eeKeyProvider = new ExternalE2EEKeyProvider();
          e2eeWorker = new Worker(new URL('livekit-client/e2ee-worker', import.meta.url));
          const keyBytes = decodeE2EEKey(e2eeKeyB64);
          await e2eeKeyProvider.setKey(keyBytes.buffer as ArrayBuffer);
        } catch (e) {
          console.warn('[CALL] E2EE setup failed, continuing without encryption:', e);
          e2eeKeyProvider = undefined;
          e2eeWorker = undefined;
        }
      }

      // Check if we were ended during async work
      if (endingRef.current || phaseRef.current === 'idle') {
        console.info('[CALL] startCall aborted — call ended during setup');
        connectingRef.current = false;
        return;
      }

      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        ...(e2eeKeyProvider && e2eeWorker ? {
          e2ee: { keyProvider: e2eeKeyProvider, worker: e2eeWorker },
        } : {}),
      });

      roomRef.current = room;

      // ── Register event listeners ONCE ──

      room.on(RoomEvent.TrackSubscribed, (track) => {
        console.debug(`[CALL] track subscribed: ${track.kind}`);
        const el = track.attach();
        if (track.kind === Track.Kind.Video && remoteVideoRef.current) {
          el.style.width = '100%';
          el.style.height = '100%';
          el.style.objectFit = 'cover';
          remoteVideoRef.current.innerHTML = '';
          remoteVideoRef.current.appendChild(el);
        } else if (track.kind === Track.Kind.Audio) {
          document.body.appendChild(el);
          el.style.display = 'none';
        }
      });

      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach().forEach(el => el.remove());
      });

      room.on(RoomEvent.Disconnected, (reason) => {
        // If safeDisconnect is already handling this, skip
        if (endingRef.current) {
          console.debug('[CALL] RoomEvent.Disconnected ignored — safeDisconnect in progress');
          return;
        }
        console.info(`[CALL] RoomEvent.Disconnected — reason: ${reason}`);
        safeDisconnect(`server_disconnect:${reason}`);
      });

      room.on(RoomEvent.ParticipantConnected, () => {
        console.info('[CALL] remote participant joined');
        hadRemoteRef.current = true;

        // Cancel no-answer timeout — call is active now
        if (noAnswerTimeoutRef.current) {
          clearTimeout(noAnswerTimeoutRef.current);
          noAnswerTimeoutRef.current = null;
          console.debug('[CALL] no-answer timeout cancelled');
        }

        // Only transition if still in connecting phase
        if (phaseRef.current === 'connecting') {
          setCallState('connected');
        }
      });

      room.on(RoomEvent.ParticipantDisconnected, () => {
        // Only end if we had a remote participant and ALL have now left
        if (hadRemoteRef.current && room.remoteParticipants.size === 0) {
          console.info('[CALL] all remote participants left');
          safeDisconnect('all_remote_left');
        }
      });

      // ── Connect to LiveKit server ──
      console.info('[CALL] connecting to room...');
      await room.connect(url, token);

      // Check if call was ended during async connect
      if (endingRef.current) {
        console.info('[CALL] call ended during room.connect — cleaning up');
        room.disconnect();
        roomRef.current = null;
        connectingRef.current = false;
        return;
      }

      console.info('[CALL] room connected successfully');

      // Enable E2EE after connection
      if (e2eeKeyProvider) {
        try {
          await room.setE2EEEnabled(true);
          setIsE2eeActive(true);
          console.info('[CALL] 🔒 E2EE enabled');
        } catch (e) {
          console.warn('[CALL] E2EE activation failed:', e);
        }
      }

      // Check again before publishing tracks
      if (endingRef.current) {
        console.info('[CALL] call ended before track publication');
        room.disconnect();
        roomRef.current = null;
        connectingRef.current = false;
        return;
      }

      // ── Publish local tracks ──
      console.info('[CALL] publishing local tracks...');
      await room.localParticipant.setMicrophoneEnabled(true);

      if (type === 'video') {
        await room.localParticipant.setCameraEnabled(true);
        const camPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
        if (camPub?.track && localVideoRef.current) {
          const el = camPub.track.attach();
          el.style.width = '100%';
          el.style.height = '100%';
          el.style.objectFit = 'cover';
          el.style.transform = 'scaleX(-1)';
          localVideoRef.current.innerHTML = '';
          localVideoRef.current.appendChild(el);
        }
      }

      console.info('[CALL] local tracks published');

      // If remote participant already in room, transition to connected
      if (room.remoteParticipants.size > 0) {
        hadRemoteRef.current = true;
        setCallState('connected');
        console.info('[CALL] remote participant already present → connected');
      } else {
        // Start no-answer timeout (only if still connecting)
        noAnswerTimeoutRef.current = setTimeout(() => {
          if (phaseRef.current === 'connecting') {
            console.info('[CALL] no answer timeout (30s)');
            toast.error("Pas de réponse");
            safeDisconnect('no_answer_timeout');
          }
        }, 30000);
      }

      connectingRef.current = false;
    } catch (err) {
      console.error('[CALL] startCall error:', err);
      toast.error("Impossible de lancer l'appel. Vérifiez votre connexion.");
      // Cleanup any partial state
      if (roomRef.current) {
        try { roomRef.current.disconnect(); } catch {}
        roomRef.current = null;
      }
      setCallState('idle');
      setIsE2eeActive(false);
      connectingRef.current = false;
      endingRef.current = false;
      releaseWakeLock();
    }
  }, [safeDisconnect]);

  // ═══════════════════════════════════════════════════════════════════
  // END CALL — public API, delegates to safeDisconnect
  // ═══════════════════════════════════════════════════════════════════
  const endCall = useCallback(() => {
    safeDisconnect('manual_end');
  }, [safeDisconnect]);

  // ═══════════════════════════════════════════════════════════════════
  // MEDIA CONTROLS
  // ═══════════════════════════════════════════════════════════════════
  const toggleMute = useCallback(() => {
    const room = roomRef.current;
    if (!room || phaseRef.current === 'idle' || phaseRef.current === 'ending') return;
    const newMuted = !isMuted;
    room.localParticipant.setMicrophoneEnabled(!newMuted);
    setIsMuted(newMuted);
  }, [isMuted]);

  const toggleCamera = useCallback(() => {
    const room = roomRef.current;
    if (!room || phaseRef.current === 'idle' || phaseRef.current === 'ending') return;
    const newOff = !isCameraOff;
    room.localParticipant.setCameraEnabled(!newOff);
    setIsCameraOff(newOff);
  }, [isCameraOff]);

  const switchToVideo = useCallback(async () => {
    const room = roomRef.current;
    if (!room || callType === 'video' || phaseRef.current === 'ending') return;

    setCallType('video');
    await room.localParticipant.setCameraEnabled(true);

    const camPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
    if (camPub?.track && localVideoRef.current) {
      const el = camPub.track.attach();
      el.style.width = '100%';
      el.style.height = '100%';
      el.style.objectFit = 'cover';
      el.style.transform = 'scaleX(-1)';
      localVideoRef.current.innerHTML = '';
      localVideoRef.current.appendChild(el);
    }
  }, [callType]);

  const switchCamera = useCallback(async () => {
    const room = roomRef.current;
    if (!room || phaseRef.current === 'ending') return;
    const camPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
    if (camPub?.track) {
      const currentSettings = (camPub.track as any).mediaStreamTrack?.getSettings?.();
      const newFacingMode = currentSettings?.facingMode === 'user' ? 'environment' : 'user';

      await room.localParticipant.setCameraEnabled(false);
      await room.localParticipant.setCameraEnabled(true, { facingMode: newFacingMode });

      const newCamPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
      if (newCamPub?.track && localVideoRef.current) {
        const el = newCamPub.track.attach();
        el.style.width = '100%';
        el.style.height = '100%';
        el.style.objectFit = 'cover';
        el.style.transform = newFacingMode === 'user' ? 'scaleX(-1)' : '';
        localVideoRef.current.innerHTML = '';
        localVideoRef.current.appendChild(el);
      }
    }
  }, []);

  // ═══════════════════════════════════════════════════════════════════
  // CLEANUP ON UNMOUNT — only if call is truly active
  // ═══════════════════════════════════════════════════════════════════
  useEffect(() => {
    return () => {
      if (roomRef.current && !endingRef.current) {
        console.info('[CALL] component unmounting with active room — ending call');
        endingRef.current = true;
        if (noAnswerTimeoutRef.current) {
          clearTimeout(noAnswerTimeoutRef.current);
          noAnswerTimeoutRef.current = null;
        }
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        try { roomRef.current.disconnect(); } catch {}
        roomRef.current = null;
        connectingRef.current = false;
        releaseWakeLock();
      }
    };
  }, []);

  return {
    callState,
    callType,
    isMuted,
    isCameraOff,
    duration,
    isE2eeActive,
    localVideoRef,
    remoteVideoRef,
    startCall,
    endCall,
    toggleMute,
    toggleCamera,
    switchToVideo,
    switchCamera,
  };
}

export function formatCallDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}
