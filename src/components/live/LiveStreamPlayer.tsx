import { useRef, useEffect, useState, forwardRef, useImperativeHandle } from 'react';
import { Radio, Camera, CameraOff, Mic, MicOff, RotateCcw } from 'lucide-react';
import { Room, RoomEvent, Track, VideoPresets, LocalTrack, createLocalTracks } from 'livekit-client';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getLiveKitToken } from '@/lib/livekit';
import { requestMediaPermissions, acquireWakeLock, releaseWakeLock, isNative } from '@/lib/platformPermissions';

interface LiveStreamPlayerProps {
  isHost?: boolean;
  roomName?: string;
  onStreamReady?: (stream?: MediaStream) => void;
  onStreamEnd?: () => void;
  className?: string;
}

export interface LiveStreamPlayerRef {
  startStream: () => Promise<void>;
  stopStream: () => void;
  toggleCamera: () => void;
  toggleMic: () => void;
  switchCamera: () => Promise<void>;
}

export const LiveStreamPlayer = forwardRef<LiveStreamPlayerRef, LiveStreamPlayerProps>(
  ({ isHost = false, roomName, onStreamReady, onStreamEnd, className }, ref) => {
    const videoRef = useRef<HTMLDivElement>(null);
    const roomRef = useRef<Room | null>(null);
    const [isStreaming, setIsStreaming] = useState(false);
    const [isCameraOn, setIsCameraOn] = useState(true);
    const [isMicOn, setIsMicOn] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    const startStream = async () => {
      if (!roomName) {
        setError('Aucune room spécifiée');
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        // Request permissions first (handles native + web)
        const perms = await requestMediaPermissions({ audio: true, video: true });
        if (!perms.granted) {
          setError(perms.error || "Autorisez l'accès à la caméra et au micro");
          setIsLoading(false);
          return;
        }

        // Keep screen awake during live
        await acquireWakeLock();

        const { token, url } = await getLiveKitToken(roomName, true);

        const room = new Room({
          adaptiveStream: true,
          dynacast: true,
          videoCaptureDefaults: {
            resolution: VideoPresets.h720.resolution,
          },
        });

        roomRef.current = room;

        room.on(RoomEvent.Disconnected, () => {
          setIsStreaming(false);
          releaseWakeLock();
          onStreamEnd?.();
        });

        await room.connect(url, token);

        // Publish camera + mic
        await room.localParticipant.enableCameraAndMicrophone();

        // Attach local video to DOM
        const camPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
        if (camPub?.track && videoRef.current) {
          const el = camPub.track.attach();
          el.style.width = '100%';
          el.style.height = '100%';
          el.style.objectFit = 'cover';
          el.style.transform = 'scaleX(-1)'; // mirror
          videoRef.current.innerHTML = '';
          videoRef.current.appendChild(el);
        }

        setIsStreaming(true);

        // Build a MediaStream from LiveKit local tracks for recording
        const mediaStream = new MediaStream();
        const camTrack = room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
        const micTrack = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
        if (camTrack?.mediaStreamTrack) mediaStream.addTrack(camTrack.mediaStreamTrack);
        if (micTrack?.mediaStreamTrack) mediaStream.addTrack(micTrack.mediaStreamTrack);

        onStreamReady?.(mediaStream);
      } catch (err: any) {
        console.error('LiveKit stream error:', err);
        let errorMessage = "Impossible de démarrer le stream";
        if (err.name === 'NotAllowedError') {
          errorMessage = isNative()
            ? "Autorisez la caméra et le micro dans les réglages de votre appareil"
            : "Autorisez l'accès à la caméra et au micro dans votre navigateur";
        } else if (err.name === 'NotFoundError') {
          errorMessage = 'Aucune caméra détectée';
        }
        setError(errorMessage);
        releaseWakeLock();
      } finally {
        setIsLoading(false);
      }
    };

    const stopStream = () => {
      if (roomRef.current) {
        roomRef.current.disconnect();
        roomRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.innerHTML = '';
      }
      setIsStreaming(false);
      releaseWakeLock();
      onStreamEnd?.();
    };

    const toggleCamera = () => {
      const room = roomRef.current;
      if (!room) return;
      const camPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
      if (camPub?.track) {
        if (isCameraOn) {
          camPub.track.mute();
        } else {
          camPub.track.unmute();
        }
        setIsCameraOn(!isCameraOn);
      }
    };

    const toggleMic = () => {
      const room = roomRef.current;
      if (!room) return;
      const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      if (micPub?.track) {
        if (isMicOn) {
          micPub.track.mute();
        } else {
          micPub.track.unmute();
        }
        setIsMicOn(!isMicOn);
      }
    };

    const switchCamera = async () => {
      const room = roomRef.current;
      if (!room) return;
      // Toggle between front and back camera by creating a new track
      const camPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
      if (camPub?.track) {
        const currentSettings = (camPub.track as any).mediaStreamTrack?.getSettings?.();
        const newFacingMode = currentSettings?.facingMode === 'user' ? 'environment' : 'user';
        
        await room.localParticipant.setCameraEnabled(false);
        await room.localParticipant.setCameraEnabled(true, {
          facingMode: newFacingMode,
        });

        // Re-attach
        const newCamPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
        if (newCamPub?.track && videoRef.current) {
          const el = newCamPub.track.attach();
          el.style.width = '100%';
          el.style.height = '100%';
          el.style.objectFit = 'cover';
          el.style.transform = newFacingMode === 'user' ? 'scaleX(-1)' : '';
          videoRef.current.innerHTML = '';
          videoRef.current.appendChild(el);
        }
      }
    };

    useImperativeHandle(ref, () => ({
      startStream,
      stopStream,
      toggleCamera,
      toggleMic,
      switchCamera,
    }));

    useEffect(() => {
      return () => {
        stopStream();
      };
    }, []);

    useEffect(() => {
      if (isHost && roomName && !isStreaming && !error) {
        startStream();
      }
    }, [isHost, roomName]);

    return (
      <div className={cn('relative w-full h-full bg-black overflow-hidden', className)}>
        <div ref={videoRef} className="w-full h-full" />

        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80">
            <div className="text-center text-white">
              <Radio className="w-12 h-12 mx-auto mb-4 animate-pulse text-destructive" />
              <p>Démarrage du live...</p>
            </div>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/90">
            <div className="text-center text-white max-w-xs px-4">
              <CameraOff className="w-16 h-16 mx-auto mb-4 text-destructive" />
              <p className="text-lg font-medium mb-2">Erreur</p>
              <p className="text-sm text-white/70 mb-4">{error}</p>
              <Button onClick={startStream} variant="secondary">
                Réessayer
              </Button>
            </div>
          </div>
        )}

        {!isStreaming && !isLoading && !error && (
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-primary/20 via-black to-secondary/20">
            <div className="text-center text-white">
              <Radio className="w-20 h-20 mx-auto mb-4 text-destructive animate-pulse" />
              <p className="text-lg opacity-70">Préparation du stream...</p>
            </div>
          </div>
        )}

        {isHost && isStreaming && (
          <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2 z-20" style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 280px)' }}>
            <Button
              size="icon"
              variant="secondary"
              onClick={switchCamera}
              className="rounded-full w-12 h-12"
            >
              <RotateCcw className="w-5 h-5" />
            </Button>
            <Button
              size="icon"
              variant="secondary"
              onClick={toggleCamera}
              className={cn(
                'rounded-full w-12 h-12',
                !isCameraOn && 'bg-destructive hover:bg-destructive/90'
              )}
            >
              {isCameraOn ? <Camera className="w-5 h-5" /> : <CameraOff className="w-5 h-5" />}
            </Button>
            <Button
              size="icon"
              variant="secondary"
              onClick={toggleMic}
              className={cn(
                'rounded-full w-12 h-12',
                !isMicOn && 'bg-destructive hover:bg-destructive/90'
              )}
            >
              {isMicOn ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
            </Button>
          </div>
        )}
      </div>
    );
  }
);

LiveStreamPlayer.displayName = 'LiveStreamPlayer';
