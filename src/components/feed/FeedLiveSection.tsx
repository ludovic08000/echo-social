import { Link } from 'react-router-dom';
import { Radio, Eye, Play } from 'lucide-react';
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
              className="flex-shrink-0 w-[140px] rounded-2xl overflow-hidden bg-black group relative aspect-[9/16]"
            >
              {/* Background */}
              {live.thumbnail_url ? (
                <img
                  src={live.thumbnail_url}
                  alt={live.title}
                  className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                />
              ) : (
                <div className="absolute inset-0 bg-gradient-to-br from-destructive/30 via-black to-primary/20 flex items-center justify-center">
                  <div className="w-12 h-12 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center">
                    <Play className="w-5 h-5 text-white ml-0.5" />
                  </div>
                </div>
              )}

              {/* Top badges */}
              <div className="absolute top-2 left-2 right-2 flex items-center justify-between z-10">
                <span className="px-2 py-0.5 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center gap-1 shadow-lg">
                  <Radio className="w-2.5 h-2.5 animate-pulse" />
                  LIVE
                </span>
                <span className="px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-sm text-white text-[10px] flex items-center gap-1">
                  <Eye className="w-2.5 h-2.5" />
                  {live.viewer_count}
                </span>
              </div>

              {/* Bottom info */}
              <div className="absolute bottom-0 left-0 right-0 p-2.5 bg-gradient-to-t from-black/90 via-black/50 to-transparent z-10">
                <div className="flex items-center gap-2 mb-1">
                  <div className="relative flex-shrink-0">
                    <UserAvatar src={live.host?.avatar_url} alt={live.host?.name} size="xs" />
                    <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-destructive border border-black" />
                  </div>
                  <p className="text-white text-[11px] font-semibold truncate">{live.host?.name}</p>
                </div>
                <p className="text-white/80 text-[10px] truncate whitespace-normal line-clamp-2 leading-snug">{live.title}</p>
              </div>

              {/* Hover */}
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors duration-300" />
            </Link>
          ))}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  );
}
