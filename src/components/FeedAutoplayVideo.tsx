import { useRef, useEffect, useState, useCallback } from 'react';
import { VolumeX, Volume2 } from 'lucide-react';
import { useAccessibilityPreferences } from '@/hooks/useAccessibilityPreferences';
import { PlaybackProgress } from '@/lib/feedTelemetry';

interface FeedAutoplayVideoProps {
  src: string;
  poster?: string | null;
  priority?: boolean;
  onMediaLoaded?: () => void;
  onVideoError?: () => void;
  onPlay?: () => void;
  onWatchComplete?: (watchedMs: number) => void;
}

export function FeedAutoplayVideo({
  src,
  poster,
  priority = false,
  onMediaLoaded,
  onVideoError,
  onPlay,
  onWatchComplete,
}: FeedAutoplayVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isMuted, setIsMuted] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const [shouldLoad, setShouldLoad] = useState(priority);
  const hasTrackedPlay = useRef(false);
  const isVisibleRef = useRef(false);
  const playback = useRef(new PlaybackProgress());
  const { autoplayVideos } = useAccessibilityPreferences();

  const tryPlay = useCallback((vid: HTMLVideoElement) => {
    if (!autoplayVideos || userPaused || !shouldLoad) return;
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
  }, [autoplayVideos, shouldLoad, userPaused]);

  useEffect(() => {
    setShouldLoad(priority);
    setUserPaused(false);
    hasTrackedPlay.current = false;
    playback.current = new PlaybackProgress();
  }, [priority, src]);

  // Do not attach the video URL for every card in the 25-item feed. Loading
  // starts only for the first screen or when a card approaches the viewport.
  useEffect(() => {
    if (priority || shouldLoad) return;
    const container = containerRef.current;
    if (!container || typeof IntersectionObserver === 'undefined') {
      setShouldLoad(true);
      return;
    }

    const preloadObserver = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setShouldLoad(true);
        preloadObserver.disconnect();
      },
      { rootMargin: '900px 0px', threshold: 0 },
    );
    preloadObserver.observe(container);
    return () => preloadObserver.disconnect();
  }, [priority, shouldLoad]);

  useEffect(() => {
    const vid = videoRef.current;
    const container = containerRef.current;
    if (!vid || !container) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        const shouldAutoplay = entry.isIntersecting && entry.intersectionRatio >= 0.35;
        isVisibleRef.current = shouldAutoplay;

        if (shouldAutoplay && autoplayVideos && !userPaused && shouldLoad) {
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
      if (autoplayVideos && !userPaused && shouldLoad && isVisibleRef.current && vid.paused) {
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
  }, [autoplayVideos, shouldLoad, tryPlay, userPaused]);

  useEffect(() => {
    if (!autoplayVideos) {
      videoRef.current?.pause();
      setIsPlaying(false);
    }
  }, [autoplayVideos]);

  useEffect(() => {
    const onVisibility = () => {
      const video = videoRef.current;
      if (!video) return;
      if (document.hidden) {
        video.pause();
        playback.current.sample(video.currentTime, video.duration, performance.now(), false);
      } else if (isVisibleRef.current) tryPlay(video);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [tryPlay]);

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
        src={shouldLoad ? src : undefined}
        poster={shouldLoad && poster ? poster : undefined}
        autoPlay={autoplayVideos}
        loop
        muted
        playsInline
        // @ts-ignore
        webkit-playsinline=""
        x-webkit-airplay="deny"
        controlsList="nodownload noremoteplayback"
        preload={priority ? 'auto' : 'metadata'}
        className="w-full h-full object-cover"
        onLoadedData={() => onMediaLoaded?.()}
        onTimeUpdate={(event) => {
          const video = event.currentTarget;
          const completed = playback.current.sample(video.currentTime, video.duration, performance.now(),
            !video.paused && !video.seeking && !document.hidden && isVisibleRef.current);
          if (completed !== null) onWatchComplete?.(completed);
        }}
        onCanPlay={() => {
          if (autoplayVideos && !userPaused && videoRef.current && isVisibleRef.current && videoRef.current.paused) {
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
        onPause={(event) => {
          setIsPlaying(false);
          playback.current.sample(event.currentTarget.currentTime, event.currentTarget.duration, performance.now(), false);
        }}
        onError={() => onVideoError?.()}
        onClick={togglePlay}
        onPointerDown={(e) => e.stopPropagation()}
      />

      <button
        type="button"
        aria-label={isMuted ? 'Activer le son' : 'Couper le son'}
        onClick={toggleMute}
        className="absolute bottom-3 right-3 z-10 w-8 h-8 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center text-white"
      >
        {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
      </button>

    </div>
  );
}
