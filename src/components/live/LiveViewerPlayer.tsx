import { useRef, useEffect, useState } from 'react';
import { Radio, Volume2, VolumeX, Maximize2, Minimize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface LiveViewerPlayerProps {
  streamUrl?: string;
  thumbnailUrl?: string;
  isLive?: boolean;
  className?: string;
}

export function LiveViewerPlayer({ 
  streamUrl, 
  thumbnailUrl, 
  isLive = true,
  className 
}: LiveViewerPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Detect iOS
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

  // Handle fullscreen
  const toggleFullscreen = async () => {
    if (!containerRef.current) return;

    try {
      if (!document.fullscreenElement) {
        // Try standard fullscreen first
        if (containerRef.current.requestFullscreen) {
          await containerRef.current.requestFullscreen();
        } 
        // iOS Safari fallback - use webkit prefix
        else if ((containerRef.current as any).webkitRequestFullscreen) {
          await (containerRef.current as any).webkitRequestFullscreen();
        }
        // For iOS video element specifically
        else if (videoRef.current && (videoRef.current as any).webkitEnterFullscreen) {
          (videoRef.current as any).webkitEnterFullscreen();
        }
        setIsFullscreen(true);
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if ((document as any).webkitExitFullscreen) {
          (document as any).webkitExitFullscreen();
        }
        setIsFullscreen(false);
      }
    } catch (err) {
      console.error('Fullscreen error:', err);
    }
  };

  // Listen for fullscreen changes
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

  // Toggle mute
  const toggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !videoRef.current.muted;
      setIsMuted(!isMuted);
    }
  };

  // Initialize video
  useEffect(() => {
    if (videoRef.current) {
      // iOS Safari specific handling
      if (isIOS) {
        videoRef.current.setAttribute('playsinline', 'true');
        videoRef.current.setAttribute('webkit-playsinline', 'true');
      }

      // Handle loading
      videoRef.current.onloadstart = () => setIsLoading(true);
      videoRef.current.oncanplay = () => setIsLoading(false);
      videoRef.current.onerror = () => {
        setIsLoading(false);
        setError('Impossible de charger le stream');
      };
    }
  }, [isIOS]);

  // For demo purposes, show placeholder if no stream URL
  if (!streamUrl) {
    return (
      <div 
        ref={containerRef}
        className={cn(
          'relative w-full h-full bg-black flex items-center justify-center overflow-hidden',
          className
        )}
      >
        {/* Background thumbnail or gradient */}
        {thumbnailUrl ? (
          <img 
            src={thumbnailUrl} 
            alt="Stream thumbnail" 
            className="absolute inset-0 w-full h-full object-cover opacity-30 blur-sm"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-primary/20 via-black to-secondary/20" />
        )}

        {/* Live indicator animation */}
        <div className="relative z-10 text-center text-white">
          <div className="relative">
            <Radio className="w-20 h-20 mx-auto text-red-500" />
            {/* Pulsing rings */}
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-24 h-24 rounded-full border-2 border-red-500/50 animate-ping" />
            </div>
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-32 h-32 rounded-full border border-red-500/30 animate-pulse" />
            </div>
          </div>
          <p className="mt-6 text-lg font-medium">Stream en direct</p>
          <p className="text-sm text-white/60 mt-1">Connexion en cours...</p>
        </div>

        {/* Controls overlay */}
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

  return (
    <div 
      ref={containerRef}
      className={cn(
        'relative w-full h-full bg-black overflow-hidden',
        className
      )}
    >
      <video
        ref={videoRef}
        src={streamUrl}
        autoPlay
        playsInline
        webkit-playsinline="true"
        muted={isMuted}
        className="w-full h-full object-contain"
      />

      {/* Loading overlay */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50">
          <div className="text-center text-white">
            <Radio className="w-12 h-12 mx-auto animate-pulse text-red-500" />
            <p className="mt-2">Chargement...</p>
          </div>
        </div>
      )}

      {/* Error overlay */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80">
          <div className="text-center text-white">
            <Radio className="w-12 h-12 mx-auto text-muted-foreground" />
            <p className="mt-2">{error}</p>
          </div>
        </div>
      )}

      {/* Live badge */}
      {isLive && (
        <div className="absolute top-4 left-4">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-red-500 text-white text-sm font-bold">
            <Radio className="w-3.5 h-3.5 animate-pulse" />
            <span>LIVE</span>
          </div>
        </div>
      )}

      {/* Controls overlay */}
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
