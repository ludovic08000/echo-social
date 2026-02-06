import { Link } from 'react-router-dom';
import { Radio, Eye } from 'lucide-react';
import { useLiveStreams } from '@/hooks/useLiveStreams';
import { UserAvatar } from '@/components/UserAvatar';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';

export function FeedLiveSection() {
  const { data: lives } = useLiveStreams();

  if (!lives || lives.length === 0) return null;

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Radio className="w-4 h-4 text-destructive animate-pulse" />
          <h3 className="font-semibold text-sm">En direct</h3>
        </div>
        <Link to="/lives" className="text-xs text-primary font-medium">
          Voir tout
        </Link>
      </div>
      <ScrollArea className="w-full whitespace-nowrap">
        <div className="flex gap-3 pb-2">
          {lives.slice(0, 6).map((live) => (
            <Link
              key={live.id}
              to={`/live/${live.id}`}
              className="flex-shrink-0 w-40 rounded-xl overflow-hidden bg-card border border-border group"
            >
              <div className="relative aspect-video bg-gradient-to-br from-destructive/20 via-secondary to-primary/10">
                {live.thumbnail_url ? (
                  <img
                    src={live.thumbnail_url}
                    alt={live.title}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Radio className="w-8 h-8 text-destructive/50" />
                  </div>
                )}
                <div className="absolute top-2 left-2">
                  <span className="px-1.5 py-0.5 rounded bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center gap-1">
                    <Radio className="w-2.5 h-2.5 animate-pulse" />
                    LIVE
                  </span>
                </div>
                <div className="absolute bottom-2 right-2">
                  <span className="px-1.5 py-0.5 rounded bg-black/60 text-white text-[10px] flex items-center gap-1">
                    <Eye className="w-2.5 h-2.5" />
                    {live.viewer_count}
                  </span>
                </div>
              </div>
              <div className="p-2 flex items-center gap-2">
                <UserAvatar src={live.host?.avatar_url} alt={live.host?.name} size="xs" />
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{live.host?.name}</p>
                  <p className="text-[10px] text-muted-foreground truncate">{live.title}</p>
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
