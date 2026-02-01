import { useState, useRef, useEffect, useCallback } from 'react';
import { useVideoFeed } from '@/hooks/useVideoFeed';
import { VideoCard } from '@/components/VideoCard';
import { ArrowUp, ArrowDown, Loader2, Video } from 'lucide-react';

export default function Videos() {
  const { data: videos, isLoading } = useVideoFeed(20);
  const [currentIndex, setCurrentIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const touchStartY = useRef(0);

  // Navigation avec clavier
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        goToNext();
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        goToPrevious();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentIndex, videos]);

  const goToNext = useCallback(() => {
    if (!videos) return;
    if (currentIndex < videos.length - 1) {
      setCurrentIndex(prev => prev + 1);
    }
  }, [currentIndex, videos]);

  const goToPrevious = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex(prev => prev - 1);
    }
  }, [currentIndex]);

  // Swipe navigation
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    const touchEndY = e.changedTouches[0].clientY;
    const diff = touchStartY.current - touchEndY;

    if (Math.abs(diff) > 50) {
      if (diff > 0) {
        goToNext();
      } else {
        goToPrevious();
      }
    }
  };

  // Wheel navigation
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    
    if (e.deltaY > 0) {
      goToNext();
    } else if (e.deltaY < 0) {
      goToPrevious();
    }
  }, [goToNext, goToPrevious]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  if (isLoading) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center">
        <Loader2 className="w-10 h-10 text-white animate-spin" />
      </div>
    );
  }

  if (!videos || videos.length === 0) {
    return (
      <div className="fixed inset-0 bg-black flex flex-col items-center justify-center text-white gap-4">
        <Video className="w-16 h-16 text-muted-foreground" />
        <h2 className="text-xl font-semibold">Aucune vidéo</h2>
        <p className="text-muted-foreground text-center px-4">
          Sois le premier à publier une vidéo !
        </p>
      </div>
    );
  }

  return (
    <div 
      ref={containerRef}
      className="fixed inset-0 bg-black overflow-hidden"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Video container with transition */}
      <div 
        className="h-full transition-transform duration-300 ease-out"
        style={{ transform: `translateY(-${currentIndex * 100}%)` }}
      >
        {videos.map((video, index) => (
          <div key={video.id} className="h-full w-full">
            <VideoCard 
              video={video} 
              isActive={index === currentIndex}
            />
          </div>
        ))}
      </div>

      {/* Navigation indicators (desktop) */}
      <div className="hidden md:flex absolute right-6 top-1/2 -translate-y-1/2 flex-col gap-2">
        <button 
          onClick={goToPrevious}
          disabled={currentIndex === 0}
          className="w-10 h-10 rounded-full bg-white/10 backdrop-blur-sm flex items-center justify-center text-white disabled:opacity-30 hover:bg-white/20 transition-colors"
        >
          <ArrowUp className="w-5 h-5" />
        </button>
        <button 
          onClick={goToNext}
          disabled={currentIndex === videos.length - 1}
          className="w-10 h-10 rounded-full bg-white/10 backdrop-blur-sm flex items-center justify-center text-white disabled:opacity-30 hover:bg-white/20 transition-colors"
        >
          <ArrowDown className="w-5 h-5" />
        </button>
      </div>

      {/* Video counter */}
      <div className="absolute top-4 right-4 md:right-auto md:left-4 px-3 py-1 rounded-full bg-black/50 backdrop-blur-sm text-white text-sm">
        {currentIndex + 1} / {videos.length}
      </div>

      {/* Back button */}
      <button
        onClick={() => window.history.back()}
        className="absolute top-4 left-4 md:hidden w-10 h-10 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center text-white"
      >
        ✕
      </button>
    </div>
  );
}
