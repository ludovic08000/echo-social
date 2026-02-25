import { useRef, useEffect, useState } from 'react';
import { Radio, Volume2, VolumeX, Maximize2, Minimize2 } from 'lucide-react';
import { Room, RoomEvent, Track, RemoteTrackPublication, RemoteParticipant } from 'livekit-client';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getLiveKitToken } from '@/lib/livekit';
import { acquireWakeLock, releaseWakeLock } from '@/lib/platformPermissions';

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
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleFullscreen = async () => {
    if (!containerRef.current) return;
    try {
      if (!document.fullscreenElement) {
        if (containerRef.current.requestFullscreen) {
          await containerRef.current.requestFullscreen();
        } else if ((containerRef.current as any).webkitRequestFullscreen) {
          await (containerRef.current as any).webkitRequestFullscreen();
        }
        setIsFullscreen(true);
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        }
        setIsFullscreen(false);
      }
    } catch (err) {
      console.error('Fullscreen error:', err);
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    };
  }, []);

  const toggleMute = () => {
    // Mute/unmute all audio elements
    if (videoRef.current) {
      const audioEls = videoRef.current.querySelectorAll('audio');
      const videoEls = videoRef.current.querySelectorAll('video');
      const newMuted = !isMuted;
      audioEls.forEach(el => el.muted = newMuted);
      videoEls.forEach(el => el.muted = newMuted);
      setIsMuted(newMuted);
    }
  };

  const attachRemoteTrack = (publication: RemoteTrackPublication) => {
    if (!publication.track || !videoRef.current) return;
    const el = publication.track.attach();
    if (publication.kind === 'video') {
      el.style.width = '100%';
      el.style.height = '100%';
      el.style.objectFit = 'cover';
    }
    videoRef.current.appendChild(el);
  };

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
        });

        roomRef.current = room;

        // When a remote track is subscribed
        room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
          if (!videoRef.current) return;
          const el = track.attach();
          if (track.kind === Track.Kind.Video) {
            el.style.width = '100%';
            el.style.height = '100%';
            el.style.objectFit = 'cover';
          }
          videoRef.current.appendChild(el);
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

        // Attach any existing tracks
        room.remoteParticipants.forEach((participant) => {
          participant.trackPublications.forEach((pub) => {
            if (pub.isSubscribed && pub.track) {
              attachRemoteTrack(pub as RemoteTrackPublication);
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
      if (roomRef.current) {
        roomRef.current.disconnect();
        roomRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.innerHTML = '';
      }
      releaseWakeLock();
    };
  }, [roomName]);

  // No roomName yet - show placeholder
  if (!roomName) {
    return (
      <div 
        ref={containerRef}
        className={cn(
          'relative w-full h-full bg-black flex items-center justify-center overflow-hidden',
          className
        )}
      >
        {thumbnailUrl ? (
          <img 
            src={thumbnailUrl} 
            alt="Stream thumbnail" 
            className="absolute inset-0 w-full h-full object-cover opacity-30 blur-sm"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-primary/20 via-black to-secondary/20" />
        )}
        <div className="relative z-10 text-center text-white">
          <div className="relative">
            <Radio className="w-20 h-20 mx-auto text-destructive" />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-24 h-24 rounded-full border-2 border-destructive/50 animate-ping" />
            </div>
          </div>
          <p className="mt-6 text-lg font-medium">Stream en direct</p>
          <p className="text-sm text-white/60 mt-1">Connexion en cours...</p>
        </div>
      </div>
    );
  }

  return (
    <div 
      ref={containerRef}
      className={cn(
        'relative w-full h-full bg-black overflow-hidden',
        className
      )}
    >
      <div ref={videoRef} className="w-full h-full" />

      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50">
          <div className="text-center text-white">
            <Radio className="w-12 h-12 mx-auto animate-pulse text-destructive" />
            <p className="mt-2">Connexion au stream...</p>
          </div>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80">
          <div className="text-center text-white">
            <Radio className="w-12 h-12 mx-auto text-muted-foreground" />
            <p className="mt-2">{error}</p>
          </div>
        </div>
      )}

      {isLive && isConnected && (
        <div className="absolute top-4 left-4">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-destructive text-destructive-foreground text-sm font-bold">
            <Radio className="w-3.5 h-3.5 animate-pulse" />
            <span>LIVE</span>
          </div>
        </div>
      )}

      <div className="absolute bottom-4 right-4 flex gap-2">
        <Button
          size="icon"
          variant="secondary"
          onClick={toggleMute}
          className="rounded-full w-10 h-10 bg-black/50 hover:bg-black/70"
        >
          {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
        </Button>
        <Button
          size="icon"
          variant="secondary"
          onClick={toggleFullscreen}
          className="rounded-full w-10 h-10 bg-black/50 hover:bg-black/70"
        >
          {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
        </Button>
      </div>
    </div>
  );
}
