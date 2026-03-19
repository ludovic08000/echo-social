import { useRef, useEffect, useState, forwardRef, useImperativeHandle, useCallback } from 'react';
import { Radio, Camera, CameraOff, Mic, MicOff, RotateCcw, Zap } from 'lucide-react';
import { Room, RoomEvent, Track, VideoPresets, VideoPreset, ConnectionQuality } from 'livekit-client';
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

/** Quality indicator dot color */
const QUALITY_COLORS: Record<string, string> = {
  excellent: 'bg-emerald-400',
  good: 'bg-yellow-400',
  poor: 'bg-red-400',
  lost: 'bg-red-600 animate-pulse',
  unknown: 'bg-muted-foreground',
};

export const LiveStreamPlayer = forwardRef<LiveStreamPlayerRef, LiveStreamPlayerProps>(
  ({ isHost = false, roomName, onStreamReady, onStreamEnd, className }, ref) => {
    const videoRef = useRef<HTMLDivElement>(null);
    const roomRef = useRef<Room | null>(null);
    const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>();
    const [isStreaming, setIsStreaming] = useState(false);
    const [isCameraOn, setIsCameraOn] = useState(true);
    const [isMicOn, setIsMicOn] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isFrontCamera, setIsFrontCamera] = useState(true);
    const [connectionQuality, setConnectionQuality] = useState<string>('unknown');
    const [isSwitchingCamera, setIsSwitchingCamera] = useState(false);

    // Attach video element with TikTok-style optimizations
    const attachVideo = useCallback((track: any, mirror: boolean) => {
      if (!videoRef.current || !track) return;
      const el = track.attach() as HTMLVideoElement;
      el.style.width = '100%';
      el.style.height = '100%';
      el.style.objectFit = 'cover';
      el.style.transform = mirror ? 'scaleX(-1)' : '';
      // Smooth rendering — prevent flicker on iOS
      el.style.willChange = 'transform';
      el.style.backfaceVisibility = 'hidden';
      el.setAttribute('playsinline', 'true');
      el.setAttribute('autoplay', 'true');
      el.muted = true; // local preview is always muted
      videoRef.current.innerHTML = '';
      videoRef.current.appendChild(el);
    }, []);

    const startStream = async () => {
      if (!roomName) {
        setError('Aucune room spécifiée');
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        const perms = await requestMediaPermissions({ audio: true, video: true });
        if (!perms.granted) {
          setError(perms.error || "Autorisez l'accès à la caméra et au micro");
          setIsLoading(false);
          return;
        }

        await acquireWakeLock();

        const { token, url } = await getLiveKitToken(roomName, true);

        const room = new Room({
          adaptiveStream: true,
          dynacast: true,
          // High-quality vertical video like TikTok
          videoCaptureDefaults: {
            resolution: { width: 1080, height: 1920, frameRate: 30 },
            facingMode: 'user',
          },
          publishDefaults: {
            // Simulcast for adaptive quality on viewer side
            simulcast: true,
            videoSimulcastLayers: [
              VideoPresets.h360,
              VideoPresets.h720,
            ],
            videoCodec: 'h264', // Best compatibility iOS/Android
            videoEncoding: {
              maxBitrate: 3_000_000, // 3 Mbps for crisp 1080p
              maxFramerate: 30,
            },
          },
          // Auto-reconnect on network issues
          reconnectPolicy: {
            nextRetryDelayInMs: (context) => {
              // Exponential backoff: 500ms, 1s, 2s, 4s, max 8s
              const delay = Math.min(500 * Math.pow(2, context.retryCount), 8000);
              return context.retryCount < 10 ? delay : null;
            },
          },
        });

        roomRef.current = room;

        // Monitor connection quality
        room.on(RoomEvent.ConnectionQualityChanged, (quality) => {
          const qualityStr = quality === ConnectionQuality.Excellent ? 'excellent'
            : quality === ConnectionQuality.Good ? 'good'
            : quality === ConnectionQuality.Poor ? 'poor'
            : quality === ConnectionQuality.Lost ? 'lost'
            : 'unknown';
          setConnectionQuality(qualityStr);
        });

        room.on(RoomEvent.Reconnecting, () => {
          setConnectionQuality('poor');
        });

        room.on(RoomEvent.Reconnected, () => {
          setConnectionQuality('good');
          // Re-attach video after reconnect
          const camPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
          if (camPub?.track) {
            attachVideo(camPub.track, isFrontCamera);
          }
        });

        room.on(RoomEvent.Disconnected, () => {
          setIsStreaming(false);
          releaseWakeLock();
          onStreamEnd?.();
        });

        await room.connect(url, token);
        await room.localParticipant.enableCameraAndMicrophone();

        // Attach local video
        const camPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
        if (camPub?.track) {
          attachVideo(camPub.track, true);
        }

        setIsStreaming(true);

        // Build MediaStream for recording
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
      clearTimeout(reconnectTimerRef.current);
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
      if (!room || isSwitchingCamera) return;

      setIsSwitchingCamera(true);
      try {
        const wantFront = !isFrontCamera;
        const newFacingMode = wantFront ? 'user' : 'environment';

        // Method 1: Use restartTrack on existing camera track (most reliable on mobile)
        const camPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
        if (camPub?.track) {
          try {
            await (camPub.track as any).restartTrack({
              facingMode: newFacingMode,
            });
            attachVideo(camPub.track, wantFront);
            setIsFrontCamera(wantFront);
            return;
          } catch (e) {
            console.warn('restartTrack failed, falling back:', e);
          }
        }

        // Method 2: Fallback — disable then re-enable with new facing mode
        await room.localParticipant.setCameraEnabled(false);
        await new Promise(r => setTimeout(r, 400));

        await room.localParticipant.setCameraEnabled(true, {
          facingMode: newFacingMode,
        });

        const newCamPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
        if (newCamPub?.track) {
          attachVideo(newCamPub.track, wantFront);
        }

        setIsFrontCamera(wantFront);
      } catch (err) {
        console.error('Switch camera error:', err);
        try {
          const camPub = room.localParticipant.getTrackPublication(Track.Source.Camera);
          if (!camPub?.track) {
            await room.localParticipant.setCameraEnabled(true);
            const reattach = room.localParticipant.getTrackPublication(Track.Source.Camera);
            if (reattach?.track) {
              attachVideo(reattach.track, isFrontCamera);
            }
          }
        } catch {}
      } finally {
        setIsSwitchingCamera(false);
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
        {/* Video container — GPU-accelerated for smooth rendering */}
        <div ref={videoRef} className="w-full h-full [&_video]:will-change-transform" />

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

        {/* Connection quality indicator */}
        {isHost && isStreaming && (
          <div className="absolute top-4 left-4 z-20 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/50 backdrop-blur-sm">
            <div className={cn('w-2 h-2 rounded-full', QUALITY_COLORS[connectionQuality] || QUALITY_COLORS.unknown)} />
            <Zap className="w-3 h-3 text-white/70" />
          </div>
        )}

        {/* Camera switching overlay */}
        {isSwitchingCamera && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-30 pointer-events-none">
            <RotateCcw className="w-10 h-10 text-white animate-spin" />
          </div>
        )}

        {isHost && isStreaming && (
          <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2 z-20" style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 280px)' }}>
            <Button
              size="icon"
              variant="secondary"
              onClick={switchCamera}
              disabled={isSwitchingCamera}
              className="rounded-full w-12 h-12"
            >
              <RotateCcw className={cn('w-5 h-5', isSwitchingCamera && 'animate-spin')} />
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
