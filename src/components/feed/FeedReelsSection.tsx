import { Link } from 'react-router-dom';
import { Play } from 'lucide-react';
import { useVideoFeed } from '@/hooks/useVideoFeed';
import { UserAvatar } from '@/components/UserAvatar';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';

export function FeedReelsSection() {
  const { data: videos } = useVideoFeed(6);

  if (!videos || videos.length === 0) return null;

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm">Reels</h3>
        <Link to="/videos" className="text-xs text-primary font-medium">
          Voir tout
        </Link>
      </div>
      <ScrollArea className="w-full whitespace-nowrap">
        <div className="flex gap-3 pb-2">
          {videos.map((video) => (
            <Link
              key={video.id}
              to="/videos"
              className="flex-shrink-0 w-28 rounded-xl overflow-hidden bg-card border border-border group relative"
            >
              <div className="relative aspect-[9/16] bg-gradient-to-b from-muted to-muted/50">
                {video.thumbnail_url ? (
                  <img
                    src={video.thumbnail_url}
                    alt={video.caption || 'Reel'}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-primary/10 to-accent/20">
                    <Play className="w-8 h-8 text-muted-foreground" />
                  </div>
                )}
                {/* Play overlay */}
                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20">
                  <div className="w-10 h-10 rounded-full bg-white/80 flex items-center justify-center">
                    <Play className="w-5 h-5 text-foreground fill-current" />
                  </div>
                </div>
                {/* Stats */}
                <div className="absolute bottom-2 left-2 right-2">
                  <div className="flex items-center gap-1 text-white text-[10px]">
                    <Play className="w-3 h-3 fill-current" />
                    <span>{formatCount(video.view_count)}</span>
                  </div>
                </div>
                {/* Author */}
                <div className="absolute top-2 left-2">
                  <UserAvatar src={video.author?.avatar_url} alt={video.author?.name} size="xs" />
                </div>
              </div>
            </Link>
          ))}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  );
}

function formatCount(count: number): string {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return count.toString();
}
