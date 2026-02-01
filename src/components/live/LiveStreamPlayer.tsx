import { useRef, useEffect, useState, forwardRef, useImperativeHandle } from 'react';
import { Radio, Camera, CameraOff, Mic, MicOff, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface LiveStreamPlayerProps {
  isHost?: boolean;
  onStreamReady?: (stream: MediaStream) => void;
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
  ({ isHost = false, onStreamReady, onStreamEnd, className }, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const [isStreaming, setIsStreaming] = useState(false);
    const [isCameraOn, setIsCameraOn] = useState(true);
    const [isMicOn, setIsMicOn] = useState(true);
    const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    // Detect iOS Safari
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

    const getMediaConstraints = (): MediaStreamConstraints => {
      return {
        video: {
          facingMode: facingMode,
          width: { ideal: 1280, max: 1920 },
          height: { ideal: 720, max: 1080 },
          frameRate: { ideal: 30, max: 60 },
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      };
    };

    const startStream = async () => {
      setIsLoading(true);
      setError(null);

      try {
        // Check if getUserMedia is supported
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('Votre navigateur ne supporte pas la capture vidéo');
        }

        // Request permissions
        const stream = await navigator.mediaDevices.getUserMedia(getMediaConstraints());
        
        streamRef.current = stream;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          
          // iOS Safari specific handling
          if (isIOS) {
            videoRef.current.setAttribute('playsinline', 'true');
            videoRef.current.setAttribute('webkit-playsinline', 'true');
          }

          // Wait for video to be ready
          await new Promise<void>((resolve, reject) => {
            if (!videoRef.current) return reject();
            
            videoRef.current.onloadedmetadata = () => {
              videoRef.current?.play()
                .then(() => resolve())
                .catch(reject);
            };
          });
        }

        setIsStreaming(true);
        onStreamReady?.(stream);
      } catch (err: any) {
        console.error('Stream error:', err);
        
        let errorMessage = 'Impossible d\'accéder à la caméra';
        
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          errorMessage = 'Autorisez l\'accès à la caméra et au micro dans les paramètres';
        } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          errorMessage = 'Aucune caméra détectée';
        } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
          errorMessage = 'La caméra est utilisée par une autre application';
        } else if (err.name === 'OverconstrainedError') {
          // Try with simpler constraints
          try {
            const simpleStream = await navigator.mediaDevices.getUserMedia({
              video: true,
              audio: true,
            });
            streamRef.current = simpleStream;
            if (videoRef.current) {
              videoRef.current.srcObject = simpleStream;
              await videoRef.current.play();
            }
            setIsStreaming(true);
            onStreamReady?.(simpleStream);
            setIsLoading(false);
            return;
          } catch {
            errorMessage = 'Configuration caméra non supportée';
          }
        }
        
        setError(errorMessage);
      } finally {
        setIsLoading(false);
      }
    };

    const stopStream = () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
      
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      
      setIsStreaming(false);
      onStreamEnd?.();
    };

    const toggleCamera = () => {
      if (streamRef.current) {
        const videoTrack = streamRef.current.getVideoTracks()[0];
        if (videoTrack) {
          videoTrack.enabled = !videoTrack.enabled;
          setIsCameraOn(videoTrack.enabled);
        }
      }
    };

    const toggleMic = () => {
      if (streamRef.current) {
        const audioTrack = streamRef.current.getAudioTracks()[0];
        if (audioTrack) {
          audioTrack.enabled = !audioTrack.enabled;
          setIsMicOn(audioTrack.enabled);
        }
      }
    };

    const switchCamera = async () => {
      const newFacingMode = facingMode === 'user' ? 'environment' : 'user';
      setFacingMode(newFacingMode);
      
      if (isStreaming) {
        stopStream();
        // Small delay before restarting with new camera
        setTimeout(() => {
          startStream();
        }, 100);
      }
    };

    // Expose methods via ref
    useImperativeHandle(ref, () => ({
      startStream,
      stopStream,
      toggleCamera,
      toggleMic,
      switchCamera,
    }));

    // Cleanup on unmount
    useEffect(() => {
      return () => {
        stopStream();
      };
    }, []);

    // Auto-start for host
    useEffect(() => {
      if (isHost && !isStreaming && !error) {
        startStream();
      }
    }, [isHost]);

    return (
      <div className={cn('relative w-full h-full bg-black overflow-hidden', className)}>
        {/* Video element */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isHost} // Mute for host to avoid feedback
          webkit-playsinline="true"
          className={cn(
            'w-full h-full object-cover',
            facingMode === 'user' && 'scale-x-[-1]' // Mirror front camera
          )}
        />

        {/* Loading state */}
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80">
            <div className="text-center text-white">
              <Radio className="w-12 h-12 mx-auto mb-4 animate-pulse text-red-500" />
              <p>Connexion à la caméra...</p>
            </div>
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/90">
            <div className="text-center text-white max-w-xs px-4">
              <CameraOff className="w-16 h-16 mx-auto mb-4 text-red-500" />
              <p className="text-lg font-medium mb-2">Accès caméra refusé</p>
              <p className="text-sm text-white/70 mb-4">{error}</p>
              <Button onClick={startStream} variant="secondary">
                Réessayer
              </Button>
            </div>
          </div>
        )}

        {/* Placeholder when not streaming */}
        {!isStreaming && !isLoading && !error && (
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-primary/20 via-black to-secondary/20">
            <div className="text-center text-white">
              <Radio className="w-20 h-20 mx-auto mb-4 text-red-500 animate-pulse" />
              <p className="text-lg opacity-70">Préparation du stream...</p>
            </div>
          </div>
        )}

        {/* Host controls */}
        {isHost && isStreaming && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2">
            <Button
              size="icon"
              variant="secondary"
              onClick={toggleCamera}
              className={cn(
                'rounded-full w-12 h-12',
                !isCameraOn && 'bg-red-500 hover:bg-red-600'
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
                !isMicOn && 'bg-red-500 hover:bg-red-600'
              )}
            >
              {isMicOn ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
            </Button>
            
            <Button
              size="icon"
              variant="secondary"
              onClick={switchCamera}
              className="rounded-full w-12 h-12"
            >
              <RotateCcw className="w-5 h-5" />
            </Button>
          </div>
        )}
      </div>
    );
  }
);

LiveStreamPlayer.displayName = 'LiveStreamPlayer';
