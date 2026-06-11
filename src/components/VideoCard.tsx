import { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Heart, MessageCircle, Bookmark, Play, Pause, Volume2, VolumeX } from 'lucide-react';
import { UserAvatar } from './UserAvatar';
import { ShortVideo, useToggleVideoLike, useToggleVideoSave, useShareVideo, useRecordVideoView } from '@/hooks/useVideoFeed';
import { ShareButton } from './ShareButton';
import { generateVideoUrl } from '@/lib/urlUtils';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';
import { guessVideoMime } from '@/lib/videoCompat';
import { useQualityTracker } from '@/hooks/useQualityTracker';


interface VideoCardProps {
  video: ShortVideo;
  isActive: boolean;
}

export function VideoCard({ video, isActive }: VideoCardProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [progress, setProgress] = useState(0);
  const [watchTime, setWatchTime] = useState(0);
  const [showPauseIcon, setShowPauseIcon] = useState(false);
  
  const toggleLike = useToggleVideoLike();
  const toggleSave = useToggleVideoSave();
  const shareVideo = useShareVideo();
  const recordView = useRecordVideoView();
  const quality = useQualityTracker({
    surface: 'video',
    contentId: video.id,
    authorId: (video as any).user_id ?? null,
    durationMs: (video.duration_seconds || 0) * 1000,
  });

  // Quality enter/leave driven by isActive
  useEffect(() => {
    if (isActive) quality.onEnter();
    else quality.onLeave();
  }, [isActive]); // eslint-disable-line react-hooks/exhaustive-deps


  // ── Core autoplay logic: react to isActive prop ──
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;

    if (isActive) {
      // Force muted for autoplay policy compliance
      vid.muted = true;
      // Reset to start if needed
      if (vid.paused) {
        const playPromise = vid.play();
        if (playPromise) {
          playPromise.catch(() => {
            // Autoplay blocked — retry after user interaction
            const retry = () => {
              vid.play().catch(() => {});
              document.removeEventListener('touchstart', retry);
              document.removeEventListener('click', retry);
            };
            document.addEventListener('touchstart', retry, { once: true });
            document.addEventListener('click', retry, { once: true });
          });
        }
      }
      setIsPlaying(true);
    } else {
      vid.pause();
      vid.currentTime = 0;
      setIsPlaying(false);
    }
  }, [isActive]);

  // Auto-start on mount if active (ensures first video plays immediately)
  useEffect(() => {
    const vid = videoRef.current;
    if (!isActive || !vid) return;

    // Small delay to let the DOM settle after mount
    const timer = setTimeout(() => {
      vid.muted = true;
      vid.play().catch(() => {});
      setIsPlaying(true);
    }, 150);
    return () => clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps


  // Track watch time
  useEffect(() => {
    if (!isActive || !isPlaying) return;

    const interval = setInterval(() => {
      setWatchTime(prev => prev + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [isActive, isPlaying]);

  // Record view when leaving
  useEffect(() => {
    return () => {
      if (watchTime > 0 && video.duration_seconds > 0) {
        recordView.mutate({
          videoId: video.id,
          watchTimeSeconds: watchTime,
          completionRate: Math.min(100, (watchTime / video.duration_seconds) * 100),
        });
      }
    };
  }, []);

  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    const current = videoRef.current.currentTime;
    const duration = videoRef.current.duration;
    setProgress((current / duration) * 100);
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    
    if (isPlaying) {
      videoRef.current.pause();
      setIsPlaying(false);
    } else {
      videoRef.current.play().catch(() => {});
      setIsPlaying(true);
    }
    // Show brief pause/play feedback icon
    setShowPauseIcon(true);
    setTimeout(() => setShowPauseIcon(false), 600);
  };

  const toggleMute = () => {
    if (!videoRef.current) return;
    videoRef.current.muted = !isMuted;
    setIsMuted(!isMuted);
  };

  const handleLike = () => {
    toggleLike.mutate({ videoId: video.id, isLiked: video.is_liked || false });
  };

  const handleSave = () => {
    toggleSave.mutate({ videoId: video.id, isSaved: video.is_saved || false });
    if (!video.is_saved) quality.onSave();
  };

  const handleShare = async () => {
    try {
      shareVideo.mutate({ videoId: video.id });
      quality.onShare();
    } catch {
      // Error handled by ShareButton
    }
  };


  const videoUrl = generateVideoUrl(video.id);

  return (
    <div ref={containerRef} className="relative w-full h-full bg-black flex items-center justify-center">
      {/* Video – autoPlay + muted for browser autoplay policy */}
      <video
        ref={videoRef}
        poster={video.thumbnail_url || undefined}
        className="w-full h-full object-cover"
        loop
        muted
        autoPlay
        playsInline
        // @ts-ignore – legacy iOS attribute
        webkit-playsinline=""
        x-webkit-airplay="deny"
        controlsList="nodownload noremoteplayback"
        preload="auto"
        onTimeUpdate={handleTimeUpdate}
        onClick={togglePlay}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onLoadedData={() => {
          // Ensure autoplay fires once data is available
          if (isActive && videoRef.current?.paused) {
            videoRef.current.play().catch(() => {});
          }
        }}
        onError={() => {
          toast({ title: 'Erreur de lecture', description: 'Cette vidéo ne peut pas être lue sur votre appareil.', variant: 'destructive' });
        }}
      >
        <source src={video.video_url} type={guessVideoMime(video.video_url)} />
      </video>

      {/* Brief tap feedback icon (not a blocking overlay) */}
      {showPauseIcon && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none animate-fade-out">
          <div className="w-20 h-20 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center">
            {isPlaying ? (
              <Play className="w-10 h-10 text-white fill-white" />
            ) : (
              <Pause className="w-10 h-10 text-white fill-white" />
            )}
          </div>
        </div>
      )}

      {/* Progress bar */}
      <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/20">
        <div 
          className="h-full bg-primary transition-all duration-100"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Info overlay */}
      <div className="absolute bottom-4 left-4 right-20 text-white">
        <Link to={`/profile/${video.user_id}`} className="flex items-center gap-2 mb-2">
          <UserAvatar src={video.author?.avatar_url} alt={video.author?.name} size="sm" />
          <span className="font-semibold text-shadow">{video.author?.name || 'Utilisateur'}</span>
        </Link>
        
        {video.caption && (
          <p className="text-sm text-white/90 line-clamp-2 text-shadow mb-2">
            {video.caption}
          </p>
        )}

        {video.hashtags && video.hashtags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {video.hashtags.slice(0, 3).map((tag, i) => (
              <span key={i} className="text-xs text-primary font-medium">
                #{tag}
              </span>
            ))}
          </div>
        )}

        {video.sound_name && (
          <div className="flex items-center gap-1 mt-2 text-xs text-white/80">
            <span className="animate-pulse">♪</span>
            <span className="truncate max-w-[150px]">{video.sound_name}</span>
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="absolute right-3 bottom-20 flex flex-col items-center gap-5">
        <button onClick={handleLike} className="flex flex-col items-center gap-1">
          <div className={cn(
            "w-12 h-12 rounded-full bg-white/10 backdrop-blur-sm flex items-center justify-center transition-all",
            video.is_liked && "bg-primary/20"
          )}>
            <Heart className={cn(
              "w-6 h-6",
              video.is_liked ? "text-primary fill-primary" : "text-white"
            )} />
          </div>
          <span className="text-white text-xs font-medium">{video.like_count}</span>
        </button>

        <Link to={`/video/${video.id}`} className="flex flex-col items-center gap-1">
          <div className="w-12 h-12 rounded-full bg-white/10 backdrop-blur-sm flex items-center justify-center">
            <MessageCircle className="w-6 h-6 text-white" />
          </div>
          <span className="text-white text-xs font-medium">{video.comment_count}</span>
        </Link>

        <button onClick={handleSave} className="flex flex-col items-center gap-1">
          <div className={cn(
            "w-12 h-12 rounded-full bg-white/10 backdrop-blur-sm flex items-center justify-center transition-all",
            video.is_saved && "bg-primary/20"
          )}>
            <Bookmark className={cn(
              "w-6 h-6",
              video.is_saved ? "text-primary fill-primary" : "text-white"
            )} />
          </div>
        </button>

        <div className="flex flex-col items-center gap-1" onClick={handleShare}>
          <ShareButton
            url={videoUrl}
            title={video.caption || 'Vidéo Pulse'}
            variant="ghost"
            className="w-12 h-12 rounded-full bg-white/10 backdrop-blur-sm hover:bg-white/20 text-white"
          />
          <span className="text-white text-xs font-medium">{video.share_count}</span>
        </div>

        <button onClick={toggleMute} className="flex flex-col items-center gap-1">
          <div className="w-12 h-12 rounded-full bg-white/10 backdrop-blur-sm flex items-center justify-center">
            {isMuted ? (
              <VolumeX className="w-6 h-6 text-white" />
            ) : (
              <Volume2 className="w-6 h-6 text-white" />
            )}
          </div>
        </button>
      </div>
    </div>
  );
}
