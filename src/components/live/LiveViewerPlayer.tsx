import { useRef, useEffect, useState, useCallback } from 'react';
import { Radio, Volume2, VolumeX, Zap } from 'lucide-react';
import { Room, RoomEvent, Track, RemoteTrackPublication, ConnectionQuality } from 'livekit-client';
import { cn } from '@/lib/utils';
import { getLiveKitToken } from '@/lib/livekit';
import { acquireWakeLock, releaseWakeLock } from '@/lib/platformPermissions';

const QUALITY_COLORS: Record<string, string> = {
  excellent: 'bg-emerald-400',
  good: 'bg-yellow-400',
  poor: 'bg-red-400',
  lost: 'bg-red-600 animate-pulse',
  unknown: 'bg-muted-foreground',
};

interface LiveViewerPlayerProps {
  roomName?: string;
  thumbnailUrl?: string;
  isLive?: boolean;
  className?: string;
}

export function LiveViewerPlayer({ 
  roomName,
  thumbnailUrl, 
  isLive = true,
  className 
}: LiveViewerPlayerProps) {
  const videoRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<Room | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMuteIcon, setShowMuteIcon] = useState(false);
  const [connectionQuality, setConnectionQuality] = useState<string>('unknown');
  const muteTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const handleTap = () => {
    if (!isConnected) return;
    const newMuted = !isMuted;
    if (videoRef.current) {
      videoRef.current.querySelectorAll('audio').forEach(el => el.muted = newMuted);
      videoRef.current.querySelectorAll('video').forEach(el => el.muted = newMuted);
    }
    setIsMuted(newMuted);
    setShowMuteIcon(true);
    clearTimeout(muteTimeoutRef.current);
    muteTimeoutRef.current = setTimeout(() => setShowMuteIcon(false), 1200);
  };

  // Attach with GPU-accelerated styles for smooth playback
  const attachTrack = useCallback((track: Track) => {
    if (!videoRef.current) return;
    const el = track.attach() as HTMLVideoElement;
    if (track.kind === Track.Kind.Video) {
      el.style.width = '100%';
      el.style.height = '100%';
      el.style.objectFit = 'cover';
      el.style.willChange = 'transform';
      el.style.backfaceVisibility = 'hidden';
      el.setAttribute('playsinline', 'true');
      el.setAttribute('autoplay', 'true');
      el.controls = false;
    }
    if (track.kind === Track.Kind.Audio) {
      (el as HTMLAudioElement).autoplay = true;
    }
    videoRef.current.appendChild(el);
  }, []);

  useEffect(() => {
    if (!roomName) return;
    let cancelled = false;

    const connect = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const { token, url } = await getLiveKitToken(roomName, false);
        if (cancelled) return;

        const room = new Room({
          adaptiveStream: true,
          dynacast: true,
          // Auto-reconnect for viewers too
          reconnectPolicy: {
            nextRetryDelayInMs: (context) => {
              const delay = Math.min(500 * Math.pow(2, context.retryCount), 8000);
              return context.retryCount < 15 ? delay : null;
            },
          },
        });
        roomRef.current = room;

        // Connection quality monitoring
        room.on(RoomEvent.ConnectionQualityChanged, (quality) => {
          const q = quality === ConnectionQuality.Excellent ? 'excellent'
            : quality === ConnectionQuality.Good ? 'good'
            : quality === ConnectionQuality.Poor ? 'poor'
            : quality === ConnectionQuality.Lost ? 'lost'
            : 'unknown';
          setConnectionQuality(q);
        });

        room.on(RoomEvent.Reconnecting, () => setConnectionQuality('poor'));
        room.on(RoomEvent.Reconnected, () => setConnectionQuality('good'));

        room.on(RoomEvent.TrackSubscribed, (track) => {
          attachTrack(track);
          setIsLoading(false);
          setIsConnected(true);
        });

        room.on(RoomEvent.TrackUnsubscribed, (track) => {
          track.detach().forEach(el => el.remove());
        });

        room.on(RoomEvent.Disconnected, () => {
          setIsConnected(false);
          releaseWakeLock();
        });

        await room.connect(url, token);
        await acquireWakeLock();
        setIsLoading(false);
        setIsConnected(true);

        // Attach already-published tracks
        room.remoteParticipants.forEach((participant) => {
          participant.trackPublications.forEach((pub) => {
            if (pub.isSubscribed && pub.track) {
              attachTrack(pub.track);
            }
          });
        });
      } catch (err: any) {
        console.error('LiveKit viewer error:', err);
        if (!cancelled) {
          setError('Impossible de se connecter au stream');
          setIsLoading(false);
        }
      }
    };

    connect();

    return () => {
      cancelled = true;
      clearTimeout(muteTimeoutRef.current);
      if (roomRef.current) {
        roomRef.current.disconnect();
        roomRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.innerHTML = '';
      }
      releaseWakeLock();
    };
  }, [roomName, attachTrack]);

  if (!roomName) {
    return (
      <div 
        ref={containerRef}
        className={cn('relative w-full h-full bg-black flex items-center justify-center overflow-hidden', className)}
      >
        {thumbnailUrl ? (
          <img src={thumbnailUrl} alt="" className="absolute inset-0 w-full h-full object-cover opacity-30 blur-sm" />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-primary/20 via-black to-secondary/20" />
        )}
        <div className="relative z-10 text-center text-white">
          <Radio className="w-16 h-16 mx-auto text-destructive animate-pulse" />
          <p className="mt-4 text-sm text-white/60">Chargement...</p>
        </div>
      </div>
    );
  }

  return (
    <div 
      ref={containerRef}
      onClick={handleTap}
      className={cn('relative w-full h-full bg-black overflow-hidden cursor-pointer select-none', className)}
    >
      {/* Video container — GPU-accelerated */}
      <div ref={videoRef} className="w-full h-full [&_video]:pointer-events-none [&_video::-webkit-media-controls]:hidden [&_video]:will-change-transform" />

      {/* Connection quality dot */}
      {isConnected && (
        <div className="absolute top-3 left-3 z-20 flex items-center gap-1 px-2 py-0.5 rounded-full bg-black/40 backdrop-blur-sm">
          <div className={cn('w-1.5 h-1.5 rounded-full', QUALITY_COLORS[connectionQuality] || QUALITY_COLORS.unknown)} />
          <Zap className="w-2.5 h-2.5 text-white/60" />
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 pointer-events-none">
          <div className="text-center text-white">
            <Radio className="w-12 h-12 mx-auto animate-pulse text-destructive" />
            <p className="mt-2 text-sm">Connexion au live...</p>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 pointer-events-none">
          <div className="text-center text-white">
            <Radio className="w-12 h-12 mx-auto text-muted-foreground" />
            <p className="mt-2">{error}</p>
          </div>
        </div>
      )}

      {/* Mute/unmute indicator */}
      {showMuteIcon && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
          <div className="w-16 h-16 rounded-full bg-black/60 backdrop-blur-sm flex items-center justify-center animate-in fade-in zoom-in duration-200">
            {isMuted ? <VolumeX className="w-8 h-8 text-white" /> : <Volume2 className="w-8 h-8 text-white" />}
          </div>
        </div>
      )}
    </div>
  );
}
