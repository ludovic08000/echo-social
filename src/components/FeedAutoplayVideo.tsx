import { useRef, useEffect, useState } from 'react';
import { Play, VolumeX, Volume2 } from 'lucide-react';

interface FeedAutoplayVideoProps {
  src: string;
  onMediaLoaded?: () => void;
  onVideoError?: () => void;
  onPlay?: () => void;
}

export function FeedAutoplayVideo({ src, onMediaLoaded, onVideoError, onPlay }: FeedAutoplayVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isMuted, setIsMuted] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const hasTrackedPlay = useRef(false);
  const isVisibleRef = useRef(false);

  // Robust autoplay: retries if metadata isn't ready yet (mobile Safari quirk).
  const tryPlay = (vid: HTMLVideoElement) => {
    vid.muted = true;
    vid.setAttribute('muted', '');
    const p = vid.play();
    if (p && typeof p.catch === 'function') {
      p.then(() => {
        if (!hasTrackedPlay.current) {
          hasTrackedPlay.current = true;
          onPlay?.();
        }
      }).catch(() => {
        // Autoplay blocked — will retry on loadeddata/canplay if still visible.
      });
    }
  };

  // IntersectionObserver: autoplay when 60% visible, pause when not
  useEffect(() => {
    const vid = videoRef.current;
    const container = containerRef.current;
    if (!vid || !container) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        isVisibleRef.current = entry.isIntersecting;
        if (entry.isIntersecting) {
          tryPlay(vid);
          setIsPlaying(true);
        } else {
          vid.pause();
          setIsPlaying(false);
        }
      },
      { threshold: 0.6 }
    );

    observer.observe(container);

    // Retry once data is ready (handles slow networks / late metadata).
    const onCanPlay = () => {
      if (isVisibleRef.current && vid.paused) tryPlay(vid);
    };
    vid.addEventListener('loadeddata', onCanPlay);
    vid.addEventListener('canplay', onCanPlay);

    return () => {
      observer.disconnect();
      vid.removeEventListener('loadeddata', onCanPlay);
      vid.removeEventListener('canplay', onCanPlay);
    };
  }, [onPlay]);

  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!videoRef.current) return;
    const next = !isMuted;
    videoRef.current.muted = next;
    setIsMuted(next);
  };

  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    const vid = videoRef.current;
    if (!vid) return;
    if (vid.paused) {
      vid.play().catch(() => {});
    } else {
      vid.pause();
    }
  };

  return (
    <div ref={containerRef} className="absolute inset-0 w-full h-full bg-black">
      <video
        ref={videoRef}
        src={src}
        loop
        muted
        playsInline
        // @ts-ignore
        webkit-playsinline=""
        x-webkit-airplay="deny"
        controlsList="nodownload noremoteplayback"
        preload="metadata"
        className="w-full h-full object-cover"
        onLoadedMetadata={() => onMediaLoaded?.()}
        onLoadedData={() => onMediaLoaded?.()}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onError={() => onVideoError?.()}
        onClick={togglePlay}
        onPointerDown={(e) => e.stopPropagation()}
      />

      {/* Mute toggle */}
      <button
        onClick={toggleMute}
        className="absolute bottom-3 right-3 z-10 w-8 h-8 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center text-white"
      >
        {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
      </button>

      {/* Play indicator when paused - tap to resume */}
      {!isPlaying && (
        <div className="absolute inset-0 flex items-center justify-center cursor-pointer" onClick={togglePlay}>
          <div className="w-14 h-14 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center">
            <Play className="w-7 h-7 text-white fill-white" />
          </div>
        </div>
      )}
    </div>
  );
}
