import { useRef, useState } from 'react';
import { Eye, Play } from 'lucide-react';
import { UserAvatar } from './UserAvatar';
import { ShortVideo } from '@/hooks/useVideoFeed';

interface VideoThumbnailCardProps {
  video: ShortVideo;
  onClick: () => void;
}

export function VideoThumbnailCard({ video, onClick }: VideoThumbnailCardProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isHovering, setIsHovering] = useState(false);

  const handleMouseEnter = () => {
    setIsHovering(true);
    if (videoRef.current) {
      videoRef.current.currentTime = 0;
      videoRef.current.play().catch(() => {});
    }
  };

  const handleMouseLeave = () => {
    setIsHovering(false);
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
  };

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <button
      onClick={onClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className="relative block w-full rounded-xl overflow-hidden bg-black aspect-[9/16] group cursor-pointer text-left"
    >
      {/* Video preview — plays on hover, muted */}
      <video
        ref={videoRef}
        src={video.video_url}
        poster={video.thumbnail_url || undefined}
        muted
        loop
        playsInline
        preload="metadata"
        className="w-full h-full object-cover"
      />

      {/* Subtle play icon when not hovering */}
      {!isHovering && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-10 h-10 rounded-full bg-black/30 backdrop-blur-sm flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
            <Play className="w-5 h-5 text-white fill-white ml-0.5" />
          </div>
        </div>
      )}

      {/* Duration badge */}
      {video.duration_seconds > 0 && (
        <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-black/60 text-white text-[10px] font-medium z-10">
          {formatDuration(video.duration_seconds)}
        </div>
      )}

      {/* View count */}
      <div className="absolute top-2 left-2 flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/60 text-white text-[10px] font-medium z-10">
        <Eye className="w-3 h-3" />
        {video.view_count >= 1000 ? `${(video.view_count / 1000).toFixed(1)}K` : video.view_count}
      </div>

      {/* Bottom info */}
      <div className="absolute bottom-0 left-0 right-0 p-2.5 bg-gradient-to-t from-black/80 via-black/40 to-transparent z-10">
        <div className="flex items-center gap-2 mb-1">
          <UserAvatar src={video.author?.avatar_url} alt={video.author?.name} size="xs" />
          <p className="text-white text-xs font-semibold truncate">{video.author?.name}</p>
        </div>
        {video.caption && (
          <p className="text-white/80 text-[11px] line-clamp-2 leading-tight">{video.caption}</p>
        )}
      </div>
    </button>
  );
}
