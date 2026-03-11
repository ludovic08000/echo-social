import { useState, useRef, useEffect, useCallback } from 'react';
import { useVideoFeed } from '@/hooks/useVideoFeed';
import { VideoCard } from '@/components/VideoCard';
import { VideoThumbnailCard } from '@/components/VideoThumbnailCard';
import { AppLayout } from '@/components/AppLayout';
import { ArrowUp, ArrowDown, Loader2, Video, X } from 'lucide-react';

export default function Videos() {
  const { data: videos, isLoading } = useVideoFeed(20);
  // TikTok-style: start in fullscreen auto-play mode by default (index 0)
  const [activeIndex, setActiveIndex] = useState<number | null>(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const touchStartY = useRef(0);

  const isFullscreen = activeIndex !== null;

  // Once videos load, ensure we start at index 0
  useEffect(() => {
    if (videos && videos.length > 0 && activeIndex === null) {
      setActiveIndex(0);
    }
  }, [videos]);

  // Keyboard navigation in fullscreen
  useEffect(() => {
    if (!isFullscreen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setActiveIndex(null);
      } else if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        goToNext();
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        goToPrevious();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeIndex, videos]);

  const goToNext = useCallback(() => {
    if (!videos) return;
    setActiveIndex(prev => prev !== null && prev < videos.length - 1 ? prev + 1 : prev);
  }, [videos]);

  const goToPrevious = useCallback(() => {
    setActiveIndex(prev => prev !== null && prev > 0 ? prev - 1 : prev);
  }, []);

  // Swipe in fullscreen
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    const diff = touchStartY.current - e.changedTouches[0].clientY;
    if (Math.abs(diff) > 50) {
      diff > 0 ? goToNext() : goToPrevious();
    }
  };

  // Wheel in fullscreen
  const handleWheel = useCallback((e: WheelEvent) => {
    if (!isFullscreen) return;
    e.preventDefault();
    e.deltaY > 0 ? goToNext() : goToPrevious();
  }, [isFullscreen, goToNext, goToPrevious]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !isFullscreen) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [handleWheel, isFullscreen]);

  if (isLoading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      </AppLayout>
    );
  }

  if (!videos || videos.length === 0) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <Video className="w-16 h-16 text-muted-foreground" />
          <h2 className="text-xl font-semibold">Aucune vidéo</h2>
          <p className="text-muted-foreground">Sois le premier à publier une vidéo !</p>
        </div>
      </AppLayout>
    );
  }

  // ─── Fullscreen player (TikTok scroll) ───
  if (isFullscreen) {
    return (
      <div
        ref={containerRef}
        className="fixed inset-0 bg-black overflow-hidden z-50"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        <div
          className="h-full transition-transform duration-300 ease-out"
          style={{ transform: `translateY(-${activeIndex! * 100}%)` }}
        >
          {videos.map((video, index) => (
            <div key={video.id} className="h-full w-full">
              <VideoCard video={video} isActive={index === activeIndex} />
            </div>
          ))}
        </div>

        {/* Close button */}
        <button
          onClick={() => setActiveIndex(null)}
          className="absolute top-4 left-4 z-50 w-10 h-10 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center text-white"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Desktop nav arrows */}
        <div className="hidden md:flex absolute right-6 top-1/2 -translate-y-1/2 flex-col gap-2 z-50">
          <button
            onClick={goToPrevious}
            disabled={activeIndex === 0}
            className="w-10 h-10 rounded-full bg-white/10 backdrop-blur-sm flex items-center justify-center text-white disabled:opacity-30 hover:bg-white/20 transition-colors"
          >
            <ArrowUp className="w-5 h-5" />
          </button>
          <button
            onClick={goToNext}
            disabled={activeIndex === videos.length - 1}
            className="w-10 h-10 rounded-full bg-white/10 backdrop-blur-sm flex items-center justify-center text-white disabled:opacity-30 hover:bg-white/20 transition-colors"
          >
            <ArrowDown className="w-5 h-5" />
          </button>
        </div>

        {/* Counter */}
        <div className="absolute top-4 right-4 px-3 py-1 rounded-full bg-black/50 backdrop-blur-sm text-white text-sm z-50">
          {activeIndex! + 1} / {videos.length}
        </div>
      </div>
    );
  }

  // ─── Mosaic grid (TikTok explore style) ───
  return (
    <AppLayout>
      <header className="mb-4">
        <h1 className="font-display text-2xl font-bold flex items-center gap-2">
          <Video className="w-6 h-6 text-primary" />
          Vidéos
        </h1>
        <p className="text-sm text-muted-foreground">{videos.length} vidéo{videos.length !== 1 ? 's' : ''}</p>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
        {videos.map((video, index) => (
          <VideoThumbnailCard
            key={video.id}
            video={video}
            onClick={() => setActiveIndex(index)}
          />
        ))}
      </div>
    </AppLayout>
  );
}
