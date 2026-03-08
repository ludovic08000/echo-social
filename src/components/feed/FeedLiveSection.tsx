import { Link } from 'react-router-dom';
import { Radio, Eye, Play, Clock, Trash2 } from 'lucide-react';
import { useLiveStreams, useDeleteLive } from '@/hooks/useLiveStreams';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { UserAvatar } from '@/components/UserAvatar';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

interface ReplayStream {
  id: string;
  title: string;
  thumbnail_url: string | null;
  total_views: number;
  category: string | null;
  ended_at: string | null;
  user_id: string;
  host?: { name: string; avatar_url: string | null };
}

function useRecentReplays() {
  return useQuery({
    queryKey: ['recent-replays'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('live_streams')
        .select('id, title, thumbnail_url, total_views, category, ended_at, user_id')
        .eq('is_active', false)
        .not('ended_at', 'is', null)
        .order('ended_at', { ascending: false })
        .limit(8);

      if (error) throw error;
      if (!data?.length) return [];

      const hostIds = [...new Set(data.map(l => l.user_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', hostIds);

      const profileMap = new Map(
        (profiles || []).map(p => [p.user_id, { name: p.name, avatar_url: p.avatar_url }])
      );

      return data.map(l => ({
        id: l.id,
        title: l.title,
        thumbnail_url: l.thumbnail_url,
        total_views: l.total_views,
        category: l.category,
        ended_at: l.ended_at,
        user_id: l.user_id,
        host: profileMap.get(l.user_id),
      })) as ReplayStream[];
    },
    staleTime: 2 * 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

function LiveTile({ 
  to, 
  thumbnailUrl, 
  isLive, 
  viewerCount, 
  hostAvatar, 
  hostName, 
  title, 
  category,
  endedAt,
  canDelete,
  onDelete,
  size = 'normal',
}: {
  to: string;
  thumbnailUrl?: string | null;
  isLive?: boolean;
  viewerCount: number;
  hostAvatar?: string | null;
  hostName?: string;
  title: string;
  category?: string | null;
  endedAt?: string | null;
  canDelete?: boolean;
  onDelete?: (e: React.MouseEvent) => void;
  size?: 'normal' | 'large';
}) {
  return (
    <Link
      to={to}
      className={cn(
        "relative block rounded-xl overflow-hidden bg-black group",
        size === 'large' ? 'row-span-2' : ''
      )}
    >
      {/* Background */}
      {thumbnailUrl ? (
        <img
          src={thumbnailUrl}
          alt={title}
          className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
        />
      ) : (
        <div className={cn(
          "absolute inset-0 flex items-center justify-center",
          isLive 
            ? "bg-gradient-to-br from-destructive/30 via-black to-primary/20"
            : "bg-gradient-to-br from-primary/20 via-black to-muted/20"
        )}>
          <div className="w-10 h-10 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center group-hover:scale-110 transition-transform">
            <Play className="w-4 h-4 text-white ml-0.5" />
          </div>
        </div>
      )}

      {/* Top badges */}
      <div className="absolute top-2 left-2 right-2 flex items-center justify-between z-10">
        {isLive ? (
          <span className="px-1.5 py-0.5 rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold flex items-center gap-1 shadow-lg">
            <Radio className="w-2.5 h-2.5 animate-pulse" />
            LIVE
          </span>
        ) : (
          <span className="px-1.5 py-0.5 rounded-full bg-secondary/80 backdrop-blur-sm text-foreground text-[9px] font-medium flex items-center gap-1">
            <Clock className="w-2.5 h-2.5" />
            Replay
          </span>
        )}
        <div className="flex items-center gap-1">
          {canDelete && onDelete && (
            <button
              onClick={onDelete}
              className="p-1 rounded-full bg-black/60 backdrop-blur-sm text-white hover:bg-destructive transition-colors"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}
          {viewerCount > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-black/60 backdrop-blur-sm text-white text-[9px] flex items-center gap-1">
              <Eye className="w-2.5 h-2.5" />
              {viewerCount}
            </span>
          )}
        </div>
      </div>

      {/* Bottom info */}
      <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/90 via-black/50 to-transparent z-10">
        <div className="flex items-center gap-1.5 mb-0.5">
          <div className="relative flex-shrink-0">
            <UserAvatar src={hostAvatar} alt={hostName} size="xs" />
            {isLive && (
              <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-destructive border border-black" />
            )}
          </div>
          <p className="text-white text-[10px] font-semibold truncate">{hostName}</p>
        </div>
        <p className="text-white/80 text-[9px] line-clamp-2 leading-snug">{title}</p>
        {!isLive && endedAt && (
          <p className="text-white/50 text-[8px] mt-0.5">
            {formatDistanceToNow(new Date(endedAt), { addSuffix: true, locale: fr })}
          </p>
        )}
        {category && (
          <span className="inline-block mt-1 px-1.5 py-0.5 rounded-full bg-white/10 backdrop-blur-sm text-white/70 text-[8px] font-medium">
            {category}
          </span>
        )}
      </div>

      {/* Hover overlay */}
      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors duration-300" />
    </Link>
  );
}

export function FeedLiveSection() {
  const { user } = useAuth();
  const { data: lives } = useLiveStreams();
  const { data: replays } = useRecentReplays();
  const deleteLive = useDeleteLive();

  const hasLives = lives && lives.length > 0;
  const hasReplays = replays && replays.length > 0;

  const handleDelete = (e: React.MouseEvent, liveId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm('Supprimer ce replay ?')) return;
    deleteLive.mutate(liveId, {
      onSuccess: () => toast({ title: 'Replay supprimé' }),
    });
  };

  if (!hasLives && !hasReplays) return null;

  // Combine all items: active lives first, then replays
  const allItems = [
    ...(lives || []).map(l => ({ ...l, isLive: true, ended_at: null as string | null })),
    ...(replays || []).map(r => ({ ...r, isLive: false, viewer_count: r.total_views, is_active: false })),
  ];

  return (
    <article className="bg-card border border-border/20 rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-destructive/10 flex items-center justify-center">
            <Radio className={cn("w-4 h-4", hasLives ? "text-destructive animate-pulse" : "text-muted-foreground")} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground leading-tight">
              {hasLives ? 'En direct' : 'Replays récents'}
            </h3>
            {hasLives && (
              <span className="text-[10px] text-destructive font-semibold">
                {lives!.length} live{lives!.length > 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>
        <Link to="/lives" className="text-xs text-primary font-medium hover:text-primary/80 transition-colors">
          Voir tout
        </Link>
      </div>

      {/* Mosaic grid — scrollable horizontally */}
      <div className="px-4 pb-4">
        <ScrollArea className="w-full">
          <div 
            className="grid grid-flow-col auto-cols-[120px] grid-rows-2 gap-2 pb-1"
            style={{ width: 'max-content' }}
          >
            {allItems.map((item, index) => {
              // First item is large (spans 2 rows) for visual hierarchy
              const isLarge = index === 0 && allItems.length > 2;
              
              return (
                <LiveTile
                  key={item.id}
                  to={`/live/${item.id}`}
                  thumbnailUrl={item.thumbnail_url}
                  isLive={item.isLive}
                  viewerCount={item.viewer_count || 0}
                  hostAvatar={item.host?.avatar_url}
                  hostName={item.host?.name}
                  title={item.title}
                  category={item.category}
                  endedAt={item.ended_at}
                  canDelete={!item.isLive && user?.id === item.user_id}
                  onDelete={!item.isLive ? (e) => handleDelete(e, item.id) : undefined}
                  size={isLarge ? 'large' : 'normal'}
                />
              );
            })}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </div>
    </article>
  );
}
