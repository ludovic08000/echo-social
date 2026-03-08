import { Link } from 'react-router-dom';
import { Play, Film } from 'lucide-react';
import { useVideoFeed } from '@/hooks/useVideoFeed';
import { UserAvatar } from '@/components/UserAvatar';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';

export function FeedReelsSection() {
  const { data: videos } = useVideoFeed(6);

  if (!videos || videos.length === 0) return null;

  return (
    <article className="bg-card border border-border/20 rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center">
            <Film className="w-4 h-4 text-primary" />
          </div>
          <h3 className="text-sm font-semibold text-foreground">Reels</h3>
        </div>
        <Link to="/videos" className="text-xs text-primary font-medium hover:text-primary/80 transition-colors">
          Voir tout
        </Link>
      </div>

      <div className="px-4 pb-4">
        <ScrollArea className="w-full whitespace-nowrap">
          <div className="flex gap-2.5 pb-1">
            {videos.map((video) => (
              <Link
                key={video.id}
                to="/videos"
                className="flex-shrink-0 w-[100px] rounded-xl overflow-hidden bg-muted group relative aspect-[9/16]"
              >
                {video.thumbnail_url ? (
                  <img
                    src={video.thumbnail_url}
                    alt={video.caption || 'Reel'}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-primary/10 to-accent/20">
                    <Play className="w-6 h-6 text-muted-foreground" />
                  </div>
                )}
                {/* Play overlay */}
                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20">
                  <div className="w-8 h-8 rounded-full bg-white/80 flex items-center justify-center">
                    <Play className="w-4 h-4 text-foreground fill-current" />
                  </div>
                </div>
                {/* Stats */}
                <div className="absolute bottom-2 left-2 right-2">
                  <div className="flex items-center gap-1 text-white text-[9px]">
                    <Play className="w-2.5 h-2.5 fill-current" />
                    <span>{formatCount(video.view_count)}</span>
                  </div>
                </div>
                {/* Author */}
                <div className="absolute top-2 left-2">
                  <UserAvatar src={video.author?.avatar_url} alt={video.author?.name} size="xs" />
                </div>
              </Link>
            ))}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </div>
    </article>
  );
}

function formatCount(count: number): string {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return count.toString();
}
