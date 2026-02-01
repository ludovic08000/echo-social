import { forwardRef } from 'react';
import { Link } from 'react-router-dom';
import { Eye, Radio } from 'lucide-react';
import { UserAvatar } from './UserAvatar';
import { LiveStream } from '@/hooks/useLiveStreams';

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
        className="group relative block rounded-2xl overflow-hidden bg-card aspect-video"
      >
        {/* Thumbnail or gradient background */}
        {live.thumbnail_url ? (
          <img 
            src={live.thumbnail_url} 
            alt={live.title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-primary/20 via-secondary to-primary/10" />
        )}

        {/* Live badge */}
        <div className="absolute top-3 left-3">
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-destructive text-destructive-foreground text-xs font-bold">
            <Radio className="w-3 h-3 animate-pulse" />
            <span>LIVE</span>
          </div>
        </div>

        {/* Viewer count */}
        <div className="absolute top-3 right-3">
          <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-black/50 backdrop-blur-sm text-white text-xs">
            <Eye className="w-3 h-3" />
            <span>{formatViewerCount(live.viewer_count)}</span>
          </div>
        </div>

        {/* Info overlay */}
        <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/80 to-transparent">
          <div className="flex items-center gap-2 mb-1">
            <UserAvatar src={live.host?.avatar_url} alt={live.host?.name} size="sm" />
            <span className="text-white font-medium text-sm">{live.host?.name}</span>
          </div>
          <p className="text-white/90 font-semibold truncate">{live.title}</p>
          
          {live.hashtags && live.hashtags.length > 0 && (
            <div className="flex gap-1 mt-1">
              {live.hashtags.slice(0, 2).map((tag, i) => (
                <span key={i} className="text-xs text-primary/90">#{tag}</span>
              ))}
            </div>
          )}
        </div>
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
