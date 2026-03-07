import { forwardRef } from 'react';
import { Link } from 'react-router-dom';
import { Eye, Radio, Play } from 'lucide-react';
import { UserAvatar } from './UserAvatar';
import { LiveStream } from '@/hooks/useLiveStreams';
import { cn } from '@/lib/utils';

interface LiveCardProps {
  live: LiveStream;
  variant?: 'card' | 'compact';
}

export const LiveCard = forwardRef<HTMLAnchorElement, LiveCardProps>(
  ({ live, variant = 'card' }, ref) => {
    if (variant === 'compact') {
      return (
        <Link 
          ref={ref}
          to={`/live/${live.id}`}
          className="flex items-center gap-3 p-3 rounded-xl bg-card hover:bg-card/80 transition-colors"
        >
          <div className="relative">
            <UserAvatar src={live.host?.avatar_url} alt={live.host?.name} size="md" />
            <div className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-destructive flex items-center justify-center">
              <Radio className="w-2.5 h-2.5 text-destructive-foreground animate-pulse" />
            </div>
          </div>
          
          <div className="flex-1 min-w-0">
            <p className="font-medium truncate">{live.host?.name}</p>
            <p className="text-sm text-muted-foreground truncate">{live.title}</p>
          </div>

          <div className="flex items-center gap-1 text-sm text-muted-foreground">
            <Eye className="w-4 h-4" />
            <span>{formatViewerCount(live.viewer_count)}</span>
          </div>
        </Link>
      );
    }

    return (
      <Link 
        ref={ref}
        to={`/live/${live.id}`}
        className="group relative block rounded-2xl overflow-hidden bg-black aspect-[9/16] hover-scale"
      >
        {/* Thumbnail or gradient background */}
        {live.thumbnail_url ? (
          <img 
            src={live.thumbnail_url} 
            alt={live.title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-destructive/30 via-black to-primary/20 flex items-center justify-center">
            <div className="w-20 h-20 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center">
              <Play className="w-8 h-8 text-white ml-1" />
            </div>
          </div>
        )}

        {/* Top badges */}
        <div className="absolute top-3 left-3 right-3 flex items-center justify-between z-10">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-destructive text-destructive-foreground text-xs font-bold shadow-lg">
            <Radio className="w-3 h-3 animate-pulse" />
            <span>LIVE</span>
          </div>
          <div className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-black/60 backdrop-blur-sm text-white text-xs font-medium">
            <Eye className="w-3 h-3" />
            <span>{formatViewerCount(live.viewer_count)}</span>
          </div>
        </div>

        {/* Bottom info overlay */}
        <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/90 via-black/50 to-transparent z-10">
          <div className="flex items-center gap-2.5 mb-2">
            <div className="relative">
              <UserAvatar src={live.host?.avatar_url} alt={live.host?.name} size="sm" />
              <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-destructive border-2 border-black" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-white font-semibold text-sm truncate">{live.host?.name}</p>
            </div>
          </div>
          <p className="text-white/90 text-sm font-medium line-clamp-2 leading-snug">{live.title}</p>
          
          {live.hashtags && live.hashtags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {live.hashtags.slice(0, 3).map((tag, i) => (
                <span key={i} className="text-xs text-primary font-medium">#{tag}</span>
              ))}
            </div>
          )}

          {live.category && live.category !== 'general' && (
            <div className="mt-2">
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/15 text-white/80 font-medium uppercase tracking-wider">
                {live.category}
              </span>
            </div>
          )}
        </div>

        {/* Hover overlay */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors duration-300" />
      </Link>
    );
  }
);

LiveCard.displayName = 'LiveCard';

function formatViewerCount(count: number): string {
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return count.toString();
}
