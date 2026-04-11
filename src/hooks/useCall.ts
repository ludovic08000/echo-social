import { useState, useCallback, useRef, useEffect } from 'react';
import { Room, RoomEvent, Track, ExternalE2EEKeyProvider, isE2EESupported } from 'livekit-client';
import { getLiveKitToken } from '@/lib/livekit';
import { requestMediaPermissions, acquireWakeLock, releaseWakeLock } from '@/lib/platformPermissions';
import { toast } from 'sonner';

export type CallType = 'audio' | 'video';
export type CallState = 'idle' | 'connecting' | 'connected' | 'ended';

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
  const [callState, setCallState] = useState<CallState>('idle');
  const [callType, setCallType] = useState<CallType>('audio');
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [duration, setDuration] = useState(0);
  const [isE2eeActive, setIsE2eeActive] = useState(false);
  const roomRef = useRef<Room | null>(null);
  const localVideoRef = useRef<HTMLDivElement | null>(null);
  const remoteVideoRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const callStateRef = useRef<CallState>('idle');
  const durationRef = useRef(0);
  const callTypeRef = useRef<CallType>('audio');
  const noAnswerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualEndRef = useRef(false);
  const hadRemoteParticipantRef = useRef(false);

  // Keep refs in sync
  useEffect(() => { callStateRef.current = callState; }, [callState]);
  useEffect(() => { durationRef.current = duration; }, [duration]);
  useEffect(() => { callTypeRef.current = callType; }, [callType]);

  // Duration timer
  useEffect(() => {
    if (callState === 'connected') {
      timerRef.current = setInterval(() => {
        setDuration(d => d + 1);
      }, 1000);
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

  const startCall = useCallback(async (conversationId: string, type: CallType, e2eeKeyB64?: string) => {
    // Request permissions before connecting
    const perms = await requestMediaPermissions({
      audio: true,
      video: type === 'video',
    });

    if (!perms.granted) {
      toast.error(perms.error || "Impossible d'accéder au micro/caméra");
      return;
    }

    setCallType(type);
    setCallState('connecting');
    setDuration(0);
    setIsMuted(false);
    setIsCameraOff(false);
    setIsE2eeActive(false);
    manualEndRef.current = false;
    hadRemoteParticipantRef.current = false;

    try {
      // Keep screen awake during call
      await acquireWakeLock();

      const roomName = `call-${conversationId}`;
      const { token, url } = await getLiveKitToken(roomName, true);

      // Setup E2EE if key provided and browser supports it
      let e2eeKeyProvider: ExternalE2EEKeyProvider | undefined;
      let e2eeWorker: Worker | undefined;
      const canE2EE = e2eeKeyB64 && isE2EESupported();

      if (canE2EE) {
        try {
          e2eeKeyProvider = new ExternalE2EEKeyProvider();
          e2eeWorker = new Worker(new URL('livekit-client/e2ee-worker', import.meta.url));
          const keyBytes = decodeE2EEKey(e2eeKeyB64);
          await e2eeKeyProvider.setKey(keyBytes);
        } catch (e) {
          console.warn('E2EE setup failed, continuing without encryption:', e);
          e2eeKeyProvider = undefined;
          e2eeWorker = undefined;
        }
      }

      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        ...(e2eeKeyProvider && e2eeWorker ? {
          e2ee: {
            keyProvider: e2eeKeyProvider,
            worker: e2eeWorker,
          },
        } : {}),
      });

      roomRef.current = room;

      room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
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

      room.on(RoomEvent.Disconnected, () => {
        if (manualEndRef.current) return;
        const wasMissed = callStateRef.current !== 'connected';
        const endDuration = durationRef.current;
        const endType = callTypeRef.current;
        setCallState('idle');
        setDuration(0);
        setIsE2eeActive(false);
        releaseWakeLock();
        options?.onCallEnded?.({ type: endType, duration: endDuration, wasMissed });
      });

      room.on(RoomEvent.ParticipantConnected, () => {
        hadRemoteParticipantRef.current = true;
        setCallState('connected');
        if (noAnswerTimeoutRef.current) {
          clearTimeout(noAnswerTimeoutRef.current);
          noAnswerTimeoutRef.current = null;
        }
      });

      room.on(RoomEvent.ParticipantDisconnected, () => {
        if (!manualEndRef.current && hadRemoteParticipantRef.current && room.remoteParticipants.size === 0) {
          room.disconnect();
        }
      });

      await room.connect(url, token);

      // Enable E2EE after connection
      if (e2eeKeyProvider) {
        try {
          await room.setE2EEEnabled(true);
          setIsE2eeActive(true);
          console.log('🔒 E2EE enabled for call');
        } catch (e) {
          console.warn('Failed to enable E2EE after connect:', e);
        }
      }

      // Enable mic always
      await room.localParticipant.setMicrophoneEnabled(true);

      // Enable camera for video calls
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

      // If someone is already in the room, we're connected
      if (room.remoteParticipants.size > 0) {
        hadRemoteParticipantRef.current = true;
        setCallState('connected');
      } else {
        setCallState('connecting');
        noAnswerTimeoutRef.current = setTimeout(() => {
          toast.error("Pas de réponse");
          if (roomRef.current) {
            roomRef.current.disconnect();
            roomRef.current = null;
          }
          if (localVideoRef.current) localVideoRef.current.innerHTML = '';
          if (remoteVideoRef.current) remoteVideoRef.current.innerHTML = '';
          setCallState('idle');
          setDuration(0);
          setIsE2eeActive(false);
          releaseWakeLock();
          options?.onCallEnded?.({ type: callTypeRef.current, duration: 0, wasMissed: true });
        }, 30000);
      }
    } catch (err) {
      console.error('Call error:', err);
      toast.error("Impossible de lancer l'appel. Vérifiez votre connexion.");
      setCallState('ended');
      setIsE2eeActive(false);
      releaseWakeLock();
    }
  }, [options]);

  const endCall = useCallback(() => {
    manualEndRef.current = true;
    hadRemoteParticipantRef.current = false;
    const wasMissed = callStateRef.current !== 'connected';
    const endDuration = durationRef.current;
    const endType = callTypeRef.current;

    if (noAnswerTimeoutRef.current) {
      clearTimeout(noAnswerTimeoutRef.current);
      noAnswerTimeoutRef.current = null;
    }
    if (roomRef.current) {
      roomRef.current.disconnect();
      roomRef.current = null;
    }
    if (localVideoRef.current) localVideoRef.current.innerHTML = '';
    if (remoteVideoRef.current) remoteVideoRef.current.innerHTML = '';
    setCallState('idle');
    setDuration(0);
    setIsE2eeActive(false);
    releaseWakeLock();
    options?.onCallEnded?.({ type: endType, duration: endDuration, wasMissed });
  }, [options]);

  const toggleMute = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    const newMuted = !isMuted;
    room.localParticipant.setMicrophoneEnabled(!newMuted);
    setIsMuted(newMuted);
  }, [isMuted]);

  const toggleCamera = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    const newOff = !isCameraOff;
    room.localParticipant.setCameraEnabled(!newOff);
    setIsCameraOff(newOff);
  }, [isCameraOff]);

  const switchToVideo = useCallback(async () => {
    const room = roomRef.current;
    if (!room || callType === 'video') return;
    
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
    if (!room) return;
    const camPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
    if (camPub?.track) {
      const currentSettings = (camPub.track as any).mediaStreamTrack?.getSettings?.();
      const newFacingMode = currentSettings?.facingMode === 'user' ? 'environment' : 'user';

      await room.localParticipant.setCameraEnabled(false);
      await room.localParticipant.setCameraEnabled(true, {
        facingMode: newFacingMode,
      });

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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (roomRef.current) {
        roomRef.current.disconnect();
      }
      releaseWakeLock();
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
