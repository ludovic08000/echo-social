import { useState, useCallback, useRef, useEffect } from 'react';
import { Room, RoomEvent, Track, ExternalE2EEKeyProvider, isE2EESupported, ConnectionQuality } from 'livekit-client';
import { getLiveKitToken } from '@/lib/livekit';
import { getCurrentDeviceId, hydrateDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';
import { requestMediaPermissions, acquireWakeLock, releaseWakeLock } from '@/lib/platformPermissions';
import { decodeCallE2EEKey } from '@/lib/calls/callKey';
import {
  AegisCallError,
  callErrorUserMessage,
  normalizeAegisCallError,
  traceCall,
} from '@/lib/calls/callDiagnostics';
import { toast } from 'sonner';
import { isAegisCallingEnabled } from '@/lib/calls/callPolicy';

export { generateCallE2EEKey } from '@/lib/calls/callKey';

export type CallType = 'audio' | 'video';
export type CallPhase = 'idle' | 'connecting' | 'connected' | 'ending';
export type CallState = CallPhase;

export interface CallEndInfo {
  type: CallType;
  duration: number;
  wasMissed: boolean;
}

interface UseCallOptions {
  onCallEnded?: (info: CallEndInfo) => void;
  onCallConnected?: () => void;
}

const ROOM_CONNECT_TIMEOUT_MS = 20_000;

function withRoomTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(
      () => reject(new AegisCallError('CALL_ROOM_CONNECT_TIMEOUT')),
      ROOM_CONNECT_TIMEOUT_MS,
    );
    operation.then(
      (value) => { globalThis.clearTimeout(timer); resolve(value); },
      (error) => { globalThis.clearTimeout(timer); reject(error); },
    );
  });
}

export function useCall(options?: UseCallOptions) {
  const [callState, setCallState] = useState<CallPhase>('idle');
  const [callType, setCallType] = useState<CallType>('audio');
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [duration, setDuration] = useState(0);
  const [isE2eeActive, setIsE2eeActive] = useState(false);
  const [connectionQuality, setConnectionQuality] = useState<'excellent' | 'good' | 'poor' | 'lost' | 'unknown'>('unknown');
  const [isScreenSharing, setIsScreenSharing] = useState(false);

  const roomRef = useRef<Room | null>(null);
  const e2eeWorkerRef = useRef<Worker | null>(null);
  const activeCallIdRef = useRef<string | null>(null);
  const localVideoRef = useRef<HTMLDivElement | null>(null);
  const remoteVideoRef = useRef<HTMLDivElement | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const noAnswerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remoteLeftGraceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const phaseRef = useRef<CallPhase>('idle');
  const durationRef = useRef(0);
  const callTypeRef = useRef<CallType>('audio');
  const hadRemoteRef = useRef(false);

  const connectingRef = useRef(false);
  const endingRef = useRef(false);

  const onCallEndedRef = useRef(options?.onCallEnded);
  const onCallConnectedRef = useRef(options?.onCallConnected);
  useEffect(() => {
    onCallEndedRef.current = options?.onCallEnded;
  }, [options?.onCallEnded]);

  useEffect(() => {
    onCallConnectedRef.current = options?.onCallConnected;
  }, [options?.onCallConnected]);

  useEffect(() => {
    phaseRef.current = callState;
  }, [callState]);

  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  useEffect(() => {
    callTypeRef.current = callType;
  }, [callType]);

  useEffect(() => {
    if (callState === 'connected') {
      timerRef.current = setInterval(() => setDuration(d => d + 1), 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [callState]);

  const clearCallTimers = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (noAnswerTimeoutRef.current) {
      clearTimeout(noAnswerTimeoutRef.current);
      noAnswerTimeoutRef.current = null;
    }
    if (remoteLeftGraceTimeoutRef.current) {
      clearTimeout(remoteLeftGraceTimeoutRef.current);
      remoteLeftGraceTimeoutRef.current = null;
    }
  }, []);

  const cleanupDom = useCallback(() => {
    if (localVideoRef.current) localVideoRef.current.innerHTML = '';
    if (remoteVideoRef.current) remoteVideoRef.current.innerHTML = '';
  }, []);

  const safeDisconnect = useCallback((reason: string) => {
    if (endingRef.current) {
      console.debug(`[CALL] safeDisconnect ignored (already ending) — ${reason}`);
      return;
    }

    if (phaseRef.current === 'idle' && !roomRef.current) {
      console.debug(`[CALL] safeDisconnect ignored (already idle) — ${reason}`);
      return;
    }

    endingRef.current = true;

    const wasMissed = phaseRef.current !== 'connected';
    const endDuration = durationRef.current;
    const endType = callTypeRef.current;
    const callId = activeCallIdRef.current ?? undefined;

    console.info(`[CALL] ending call — reason=${reason}, phase=${phaseRef.current}, duration=${endDuration}s`);

    clearCallTimers();

    const room = roomRef.current;
    roomRef.current = null;
    activeCallIdRef.current = null;

    if (room) {
      try {
        room.disconnect();
      } catch {
        console.warn('[CALL] room disconnect failed');
      }
    }
    if (e2eeWorkerRef.current) {
      try { e2eeWorkerRef.current.terminate(); } catch { /* already stopped */ }
      e2eeWorkerRef.current = null;
    }

    cleanupDom();

    setCallState('idle');
    setDuration(0);
    setIsE2eeActive(false);
    setIsMuted(false);
    setIsCameraOff(false);

    phaseRef.current = 'idle';
    connectingRef.current = false;
    hadRemoteRef.current = false;

    releaseWakeLock();

    traceCall({
      direction: 'local',
      stage: 'disconnect',
      outcome: 'ok',
      callId,
    });

    onCallEndedRef.current?.({
      type: endType,
      duration: endDuration,
      wasMissed,
    });

    queueMicrotask(() => {
      endingRef.current = false;
    });
  }, [cleanupDom, clearCallTimers]);

  const markConnected = useCallback(() => {
    if (phaseRef.current === 'connected') return;
    phaseRef.current = 'connected';
    setCallState('connected');
    onCallConnectedRef.current?.();
  }, []);

  const startCall = useCallback(async (callId: string, type: CallType, e2eeKeyB64: string): Promise<boolean> => {
    if (!isAegisCallingEnabled()) {
      const error = new AegisCallError('CALLS_DISABLED');
      traceCall({ direction: 'local', stage: 'start', outcome: 'skip', callId, errorCode: error.code });
      toast.error(callErrorUserMessage(error));
      return false;
    }
    if (connectingRef.current) {
      console.warn('[CALL] startCall ignored — already connecting');
      traceCall({ direction: 'local', stage: 'start', outcome: 'skip', callId, errorCode: 'CALL_ALREADY_ACTIVE' });
      return false;
    }

    if (roomRef.current) {
      console.warn('[CALL] startCall ignored — room already exists');
      traceCall({ direction: 'local', stage: 'start', outcome: 'skip', callId, errorCode: 'CALL_ALREADY_ACTIVE' });
      return false;
    }

    if (phaseRef.current !== 'idle') {
      console.warn(`[CALL] startCall ignored — invalid phase ${phaseRef.current}`);
      traceCall({ direction: 'local', stage: 'start', outcome: 'skip', callId, errorCode: 'CALL_ALREADY_ACTIVE' });
      return false;
    }

    connectingRef.current = true;
    endingRef.current = false;
    hadRemoteRef.current = false;
    activeCallIdRef.current = callId;

    setCallType(type);
    setCallState('connecting');
    phaseRef.current = 'connecting';
    setDuration(0);
    setIsMuted(false);
    setIsCameraOff(false);
    setIsE2eeActive(false);

    console.info(`[CALL] starting ${type} call`);
    traceCall({ direction: 'local', stage: 'start', outcome: 'start', callId });

    try {
      const keyBytes = decodeCallE2EEKey(e2eeKeyB64);

      if (!isE2EESupported()) {
        throw new AegisCallError('CALL_E2EE_UNSUPPORTED');
      }

      const mediaStartedAt = Date.now();
      traceCall({ direction: 'local', stage: 'media_permission', outcome: 'start', callId });
      const perms = await requestMediaPermissions({
        audio: true,
        video: type === 'video',
      });

      if (!perms.granted) {
        throw new AegisCallError('CALL_MEDIA_PERMISSION_DENIED');
      }
      traceCall({ direction: 'local', stage: 'media_permission', outcome: 'ok', callId, elapsedMs: Date.now() - mediaStartedAt });

      await acquireWakeLock();

      const deviceId = await hydrateDeviceId().catch(() => getCurrentDeviceId());
      if (!deviceId || isDeviceIdTemporary()) {
        throw new AegisCallError('CALL_CURRENT_DEVICE_NOT_READY');
      }
      const roomName = `call-${callId}`;
      const { token, url } = await getLiveKitToken(roomName, true, deviceId);

      let e2eeKeyProvider: ExternalE2EEKeyProvider | undefined;
      let e2eeWorker: Worker | undefined;

      try {
        e2eeKeyProvider = new ExternalE2EEKeyProvider();
        e2eeWorker = new Worker(new URL('livekit-client/e2ee-worker', import.meta.url));
        e2eeWorkerRef.current = e2eeWorker;
        await e2eeKeyProvider.setKey(keyBytes.buffer as ArrayBuffer);
      } catch (err) {
        console.error('[CALL] E2EE init failed');
        throw new AegisCallError('CALL_E2EE_INIT_FAILED', { cause: err });
      }

      if (endingRef.current || phaseRef.current !== 'connecting') {
        console.info('[CALL] start aborted before room creation');
        try { e2eeWorker.terminate(); } catch { /* already stopped */ }
        e2eeWorkerRef.current = null;
        connectingRef.current = false;
        releaseWakeLock();
        return false;
      }

      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
          sampleRate: 48000,
        },
        audioOutput: {
          deviceId: 'default',
        },
        ...(e2eeKeyProvider && e2eeWorker
          ? { e2ee: { keyProvider: e2eeKeyProvider, worker: e2eeWorker } }
          : {}),
      });

      roomRef.current = room;

      room.on(RoomEvent.TrackSubscribed, (track) => {
        console.debug(`[CALL] track subscribed: ${track.kind}`);
        const el = track.attach();

        if (track.kind === Track.Kind.Video && remoteVideoRef.current) {
          el.style.width = '100%';
          el.style.height = '100%';
          el.style.objectFit = 'cover';
          remoteVideoRef.current.innerHTML = '';
          remoteVideoRef.current.appendChild(el);
          return;
        }

        if (track.kind === Track.Kind.Audio) {
          // Use invisible positioning instead of display:none
          // Some browsers (Safari/iOS) block playback for display:none elements
          el.style.position = 'absolute';
          el.style.opacity = '0';
          el.style.width = '0';
          el.style.height = '0';
          el.style.pointerEvents = 'none';
          el.setAttribute('playsinline', '');
          (el as HTMLMediaElement).autoplay = true;
          (el as HTMLMediaElement).muted = false;
          (el as HTMLMediaElement).volume = 1.0;
          document.body.appendChild(el);

          // Force play with autoplay-policy fallback
          const mediaEl = el as HTMLMediaElement;
          mediaEl.play().catch(() => {
            const resumeAudio = () => {
              mediaEl.play().catch(() => {});
              document.removeEventListener('click', resumeAudio);
              document.removeEventListener('touchstart', resumeAudio);
            };
            document.addEventListener('click', resumeAudio, { once: true });
            document.addEventListener('touchstart', resumeAudio, { once: true });
          });
        }
      });

      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach().forEach(el => el.remove());
      });

      // Network quality indicator (WhatsApp-style)
      room.on(RoomEvent.ConnectionQualityChanged, (quality) => {
        const q = quality === ConnectionQuality.Excellent ? 'excellent'
          : quality === ConnectionQuality.Good ? 'good'
          : quality === ConnectionQuality.Poor ? 'poor'
          : quality === ConnectionQuality.Lost ? 'lost'
          : 'unknown';
        setConnectionQuality(q);
      });

      room.on(RoomEvent.Disconnected, (reason) => {
        if (endingRef.current) {
          console.debug('[CALL] RoomEvent.Disconnected ignored — safeDisconnect already running');
          return;
        }
        console.warn(`[CALL] RoomEvent.Disconnected unexpected — ${String(reason)}`);
        safeDisconnect(`room_disconnected:${String(reason)}`);
      });

      room.on(RoomEvent.ParticipantConnected, () => {
        console.info('[CALL] remote participant joined');
        hadRemoteRef.current = true;

        if (remoteLeftGraceTimeoutRef.current) {
          clearTimeout(remoteLeftGraceTimeoutRef.current);
          remoteLeftGraceTimeoutRef.current = null;
        }

        if (noAnswerTimeoutRef.current) {
          clearTimeout(noAnswerTimeoutRef.current);
          noAnswerTimeoutRef.current = null;
          console.debug('[CALL] no-answer timeout cancelled');
        }

        if (phaseRef.current === 'connecting') {
          markConnected();
        }
      });

      room.on(RoomEvent.ParticipantDisconnected, () => {
        const currentRoom = roomRef.current;
        if (!currentRoom) return;
        if (!hadRemoteRef.current) return;
        if (endingRef.current) return;

        if (currentRoom.remoteParticipants.size > 0) {
          return;
        }

        console.info('[CALL] all remote participants left — starting 5s grace timer');

        if (remoteLeftGraceTimeoutRef.current) {
          clearTimeout(remoteLeftGraceTimeoutRef.current);
        }

        remoteLeftGraceTimeoutRef.current = setTimeout(() => {
          const activeRoom = roomRef.current;
          if (!activeRoom || endingRef.current) return;

          if (activeRoom.remoteParticipants.size === 0) {
            safeDisconnect('all_remote_left');
          }
        }, 5000);
      });

      console.info('[CALL] connecting room...');
      const connectStartedAt = Date.now();
      traceCall({ direction: 'local', stage: 'room_connect', outcome: 'start', callId, deviceId });
      try {
        await withRoomTimeout(room.connect(url, token));
      } catch (error) {
        const normalized = normalizeAegisCallError(error, 'CALL_ROOM_CONNECT_FAILED');
        throw normalized.code === 'CALL_ROOM_CONNECT_TIMEOUT'
          ? normalized
          : new AegisCallError('CALL_ROOM_CONNECT_FAILED', { cause: error });
      }
      traceCall({ direction: 'local', stage: 'room_connect', outcome: 'ok', callId, deviceId, elapsedMs: Date.now() - connectStartedAt });

      if (endingRef.current || roomRef.current !== room) {
        console.info('[CALL] call ended during connect — cleaning up');
        try { room.disconnect(); } catch { /* room may already be disconnected */ }
        if (e2eeWorkerRef.current) {
          try { e2eeWorkerRef.current.terminate(); } catch { /* already stopped */ }
          e2eeWorkerRef.current = null;
        }
        roomRef.current = null;
        connectingRef.current = false;
        releaseWakeLock();
        return false;
      }

      console.info('[CALL] room connected');

      try {
        await room.setE2EEEnabled(true);
        setIsE2eeActive(true);
        console.info('[CALL] LiveKit E2EE enabled');
      } catch (err) {
        console.error('[CALL] LiveKit E2EE enable failed');
        throw new AegisCallError('CALL_E2EE_ENABLE_FAILED', { cause: err });
      }

      if (endingRef.current || roomRef.current !== room) {
        console.info('[CALL] call ended before local track publication — cleaning up');
        try { room.disconnect(); } catch { /* room may already be disconnected */ }
        if (e2eeWorkerRef.current) {
          try { e2eeWorkerRef.current.terminate(); } catch { /* already stopped */ }
          e2eeWorkerRef.current = null;
        }
        roomRef.current = null;
        connectingRef.current = false;
        releaseWakeLock();
        return false;
      }

      console.info('[CALL] publishing local tracks...');
      try {
        await room.localParticipant.setMicrophoneEnabled(true, {
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
          sampleRate: 48000,
        });

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
      } catch (error) {
        throw new AegisCallError('CALL_TRACK_PUBLISH_FAILED', { cause: error });
      }

      console.info('[CALL] local tracks published');

      if (room.remoteParticipants.size > 0) {
        hadRemoteRef.current = true;
        markConnected();
        console.info('[CALL] remote participant already present → connected');
      } else {
        noAnswerTimeoutRef.current = setTimeout(() => {
          if (phaseRef.current === 'connecting' && !endingRef.current) {
            console.info('[CALL] no answer timeout (30s)');
            toast.error('Pas de réponse');
            safeDisconnect('no_answer_timeout');
          }
        }, 30000);
      }

      connectingRef.current = false;
      traceCall({ direction: 'local', stage: 'start', outcome: 'ok', callId });
      return true;
    } catch (err) {
      const normalized = normalizeAegisCallError(err);
      console.error(`[CALL] start failed (${normalized.code})`);
      traceCall({
        direction: 'local',
        stage: 'start',
        outcome: 'error',
        callId,
        errorCode: normalized.code,
        diagnosticId: normalized.diagnosticId,
      });
      toast.error(callErrorUserMessage(normalized));
      safeDisconnect('start_call_error');
      return false;
    }
  }, [markConnected, safeDisconnect]);

  const endCall = useCallback(() => {
    safeDisconnect('manual_end');
  }, [safeDisconnect]);

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

  const toggleScreenShare = useCallback(async () => {
    const room = roomRef.current;
    if (!room || phaseRef.current === 'ending') return;
    try {
      const enabled = room.localParticipant.isScreenShareEnabled;
      await room.localParticipant.setScreenShareEnabled(!enabled, { audio: true });
      setIsScreenSharing(!enabled);
      if (!enabled) toast.success('Partage d\u2019\u00e9cran activ\u00e9');
      else toast.message('Partage d\u2019\u00e9cran arr\u00eat\u00e9');
    } catch {
      console.error('[CALL] screen share toggle failed');
      toast.error('Partage d\u2019\u00e9cran indisponible');
    }
  }, []);

  const switchCamera = useCallback(async () => {
    const room = roomRef.current;
    if (!room || phaseRef.current === 'ending') return;

    const camPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
    if (camPub?.track) {
      const currentSettings = camPub.track.mediaStreamTrack.getSettings();
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

  useEffect(() => {
    return () => {
      if (roomRef.current || phaseRef.current !== 'idle') {
        console.info('[CALL] unmount cleanup');
        safeDisconnect('component_unmount');
      }
    };
  }, [safeDisconnect]);

  return {
    callState,
    callType,
    isMuted,
    isCameraOff,
    duration,
    isE2eeActive,
    connectionQuality,
    localVideoRef,
    remoteVideoRef,
    room: roomRef.current,
    startCall,
    endCall,
    toggleMute,
    toggleCamera,
    isScreenSharing,
    switchToVideo,
    switchCamera,
    toggleScreenShare,
  };
}

export function formatCallDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}
