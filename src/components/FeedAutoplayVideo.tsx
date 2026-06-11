import { useRef, useEffect, useState } from 'react';
import { VolumeX, Volume2 } from 'lucide-react';

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
  const [userPaused, setUserPaused] = useState(false);
  const hasTrackedPlay = useRef(false);
  const isVisibleRef = useRef(false);

  const tryPlay = (vid: HTMLVideoElement) => {
    vid.muted = true;
    vid.defaultMuted = true;
    vid.playsInline = true;
    vid.setAttribute('muted', '');
    vid.setAttribute('playsinline', '');
    vid.setAttribute('webkit-playsinline', '');

    const playPromise = vid.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => {
        setIsPlaying(false);
      });
    }
  };

  useEffect(() => {
    const vid = videoRef.current;
    const container = containerRef.current;
    if (!vid || !container) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        const shouldAutoplay = entry.isIntersecting && entry.intersectionRatio >= 0.35;
        isVisibleRef.current = shouldAutoplay;

        if (shouldAutoplay) {
          if (vid.readyState < 2) {
            vid.load();
            requestAnimationFrame(() => tryPlay(vid));
          } else {
            tryPlay(vid);
          }
        } else {
          vid.pause();
          setIsPlaying(false);
        }
      },
      { threshold: [0, 0.2, 0.35, 0.6] }
    );

    const retryWhenReady = () => {
      if (isVisibleRef.current && vid.paused) {
        tryPlay(vid);
      }
    };

    observer.observe(container);
    vid.addEventListener('loadedmetadata', retryWhenReady);
    vid.addEventListener('loadeddata', retryWhenReady);
    vid.addEventListener('canplay', retryWhenReady);

    return () => {
      observer.disconnect();
      vid.removeEventListener('loadedmetadata', retryWhenReady);
      vid.removeEventListener('loadeddata', retryWhenReady);
      vid.removeEventListener('canplay', retryWhenReady);
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
      setUserPaused(false);
      vid.play().catch(() => {});
    } else {
      setUserPaused(true);
      vid.pause();
    }
  };

  return (
    <div ref={containerRef} className="absolute inset-0 w-full h-full bg-black">
      <video
        ref={videoRef}
        src={src}
        autoPlay
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
        onCanPlay={() => {
          if (videoRef.current && isVisibleRef.current && videoRef.current.paused) {
            tryPlay(videoRef.current);
          }
        }}
        onPlay={() => {
          setIsPlaying(true);
          if (!hasTrackedPlay.current) {
            hasTrackedPlay.current = true;
            onPlay?.();
          }
        }}
        onPause={() => setIsPlaying(false)}
        onError={() => onVideoError?.()}
        onClick={togglePlay}
        onPointerDown={(e) => e.stopPropagation()}
      />

      <button
        onClick={toggleMute}
        className="absolute bottom-3 right-3 z-10 w-8 h-8 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center text-white"
      >
        {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
      </button>

    </div>
  );
}
