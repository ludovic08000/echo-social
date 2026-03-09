import { useState, useCallback, useRef, useEffect } from 'react';
import { Room, RoomEvent, Track, RemoteTrackPublication } from 'livekit-client';
import { getLiveKitToken } from '@/lib/livekit';
import { requestMediaPermissions, acquireWakeLock, releaseWakeLock } from '@/lib/platformPermissions';
import { toast } from 'sonner';

export type CallType = 'audio' | 'video';
export type CallState = 'idle' | 'connecting' | 'connected' | 'ended';

export interface CallEndInfo {
  type: CallType;
  duration: number;
  wasMissed: boolean; // true if nobody ever connected
}

interface UseCallOptions {
  onCallEnded?: (info: CallEndInfo) => void;
}

export function useCall(options?: UseCallOptions) {
  const [callState, setCallState] = useState<CallState>('idle');
  const [callType, setCallType] = useState<CallType>('audio');
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [duration, setDuration] = useState(0);
  const roomRef = useRef<Room | null>(null);
  const localVideoRef = useRef<HTMLDivElement | null>(null);
  const remoteVideoRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const callStateRef = useRef<CallState>('idle');
  const durationRef = useRef(0);
  const callTypeRef = useRef<CallType>('audio');

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

  const startCall = useCallback(async (conversationId: string, type: CallType) => {
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

    try {
      // Keep screen awake during call
      await acquireWakeLock();

      const roomName = `call-${conversationId}`;
      const { token, url } = await getLiveKitToken(roomName, true);

      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
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
        const wasMissed = callStateRef.current !== 'connected';
        const endDuration = durationRef.current;
        const endType = callTypeRef.current;
        setCallState('ended');
        releaseWakeLock();
        options?.onCallEnded?.({ type: endType, duration: endDuration, wasMissed });
      });

      room.on(RoomEvent.ParticipantConnected, () => {
        setCallState('connected');
        // Clear the no-answer timeout
        if (noAnswerTimeoutRef.current) {
          clearTimeout(noAnswerTimeoutRef.current);
          noAnswerTimeoutRef.current = null;
        }
      });

      await room.connect(url, token);

      // Enable mic always
      await room.localParticipant.setMicrophoneEnabled(true);

      // Enable camera for video calls
      if (type === 'video') {
        await room.localParticipant.setCameraEnabled(true);

        // Attach local video
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
        setCallState('connected');
      } else {
        setCallState('connecting');
        // Auto-end after 30s if no one joins
        noAnswerTimeoutRef.current = setTimeout(() => {
          toast.error("Pas de réponse");
          endCallInternal();
        }, 30000);
      }
    } catch (err) {
      console.error('Call error:', err);
      toast.error("Impossible de lancer l'appel. Vérifiez votre connexion.");
      setCallState('ended');
      releaseWakeLock();
    }
  }, [options]);

  const endCall = useCallback(() => {
    const wasMissed = callStateRef.current !== 'connected';
    const endDuration = durationRef.current;
    const endType = callTypeRef.current;

    if (roomRef.current) {
      roomRef.current.disconnect();
      roomRef.current = null;
    }
    if (localVideoRef.current) localVideoRef.current.innerHTML = '';
    if (remoteVideoRef.current) remoteVideoRef.current.innerHTML = '';
    setCallState('idle');
    setDuration(0);
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
