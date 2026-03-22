import { Link } from 'react-router-dom';
import { Radio, Eye, Clock, Trash2, Video } from 'lucide-react';
import { useLiveStreams, useDeleteLive } from '@/hooks/useLiveStreams';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { UserAvatar } from '@/components/UserAvatar';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { formatDistanceToNow } from 'date-fns';
import { fr } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { useRef } from 'react';
import { useIsMobile } from '@/hooks/use-mobile';

interface ReplayStream {
  id: string;
  title: string;
  thumbnail_url: string | null;
  recording_url: string | null;
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
        .select('id, title, thumbnail_url, recording_url, total_views, category, ended_at, user_id')
        .eq('is_active', false)
        .not('ended_at', 'is', null)
        .order('ended_at', { ascending: false })
        .limit(10);

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
        ...l,
        host: profileMap.get(l.user_id),
      })) as ReplayStream[];
    },
    staleTime: 2 * 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

// Premium mini live card
function LiveCard({ item }: { item: { id: string; title: string; thumbnail_url: string | null; recording_url?: string | null; isLive: boolean; viewer_count: number; user_id: string; ended_at: string | null; host?: { name: string; avatar_url: string | null } } }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { user } = useAuth();
  const deleteLive = useDeleteLive();
  const isMobile = useIsMobile();

  const handleDelete = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    deleteLive.mutate(item.id);
  };

  const hasVideo = !isMobile && !!item.recording_url;
  const hasThumbnail = !!item.thumbnail_url;
  const linkTo = item.isLive ? `/live/${item.id}` : `/live/${item.id}?from=feed`;

  return (
    <Link
      to={linkTo}
      className="relative flex-shrink-0 w-[120px] h-[170px] rounded-2xl overflow-hidden bg-black/60 group"
    >
      {/* Background */}
      {hasVideo ? (
        <video
          ref={videoRef}
          src={`${item.recording_url!}#t=0.5`}
          className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.03]"
          muted loop autoPlay playsInline preload="auto"
          poster={item.thumbnail_url || undefined}
        />
      ) : hasThumbnail ? (
        <img
          src={item.thumbnail_url!}
          alt={item.title}
          loading="lazy"
          className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.03]"
        />
      ) : (
        <div className={cn(
          "absolute inset-0 flex flex-col items-center justify-center gap-2.5",
          item.isLive
            ? "bg-gradient-to-br from-destructive/20 via-black/80 to-accent/10"
            : "bg-gradient-to-br from-primary/10 via-black/90 to-black"
        )}>
          <div className="w-10 h-10 rounded-xl bg-white/[0.06] backdrop-blur flex items-center justify-center border border-white/[0.08]">
            {item.isLive ? (
              <Radio className="w-4 h-4 text-white/60 animate-pulse" />
            ) : (
              <Video className="w-4 h-4 text-white/30" />
            )}
          </div>
          <UserAvatar src={item.host?.avatar_url} alt={item.host?.name} size="xs" />
        </div>
      )}

      {/* Gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-black/20" />

      {/* Top badges */}
      <div className="absolute top-2 left-2 right-2 flex items-center justify-between z-10">
        {item.isLive ? (
          <span className="px-1.5 py-0.5 rounded-lg bg-destructive/90 text-white text-[8px] font-bold flex items-center gap-0.5 shadow-lg backdrop-blur-sm">
            <Radio className="w-2 h-2 animate-pulse" />
            LIVE
          </span>
        ) : null}
        {!item.isLive && user?.id === item.user_id && (
          <button
            onClick={handleDelete}
            className="p-1.5 rounded-lg bg-black/40 backdrop-blur-sm text-white/60 hover:bg-destructive/80 hover:text-white transition-all duration-300"
          >
            <Trash2 className="w-2.5 h-2.5" />
          </button>
        )}
      </div>

      {/* Viewers */}
      {item.viewer_count > 0 && (
        <div className="absolute top-2 right-2 z-10">
          <span className="px-1.5 py-0.5 rounded-lg bg-black/40 backdrop-blur-md text-white/60 text-[8px] flex items-center gap-0.5 font-medium">
            <Eye className="w-2 h-2" />
            {item.viewer_count}
          </span>
        </div>
      )}

      {/* Bottom info */}
      <div className="absolute bottom-0 left-0 right-0 p-2.5 z-10">
        <div className="flex items-center gap-1.5 mb-1">
          {(hasVideo || hasThumbnail) && (
            <UserAvatar src={item.host?.avatar_url} alt={item.host?.name} size="xs" />
          )}
          <span className="text-white text-[9px] font-semibold truncate">
            {item.host?.name || 'Utilisateur'}
          </span>
        </div>
        <p className="text-white/50 text-[9px] line-clamp-2 leading-snug font-medium">{item.title}</p>
        {!item.isLive && item.ended_at && (
          <p className="text-white/20 text-[7px] mt-0.5 font-medium">
            {formatDistanceToNow(new Date(item.ended_at), { addSuffix: true, locale: fr })}
          </p>
        )}
      </div>

      {/* Hover ring */}
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none rounded-2xl ring-1 ring-inset ring-white/[0.08]" />
    </Link>
  );
}

export function FeedLiveSection() {
  const { data: lives } = useLiveStreams();
  const { data: replays } = useRecentReplays();

  const hasLives = lives && lives.length > 0;
  const hasReplays = replays && replays.length > 0;

  if (!hasLives && !hasReplays) return null;

  const allItems = [
    ...(lives || []).map(l => ({ ...l, isLive: true, ended_at: null as string | null, recording_url: l.recording_url || null })),
    ...(replays || []).map(r => ({ ...r, isLive: false, viewer_count: r.total_views, is_active: false })),
  ];

  return (
    <article className="bg-card/80 border border-border/10 rounded-2xl overflow-hidden backdrop-blur-sm">
      <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-xl bg-destructive/10 flex items-center justify-center">
            <Radio className={cn("w-3.5 h-3.5", hasLives ? "text-destructive animate-pulse" : "text-muted-foreground/50")} />
          </div>
          <h3 className="text-sm font-semibold text-foreground/90 tracking-tight">
            {hasLives ? 'En direct' : 'Replays'}
          </h3>
          {hasLives && (
            <span className="px-2 py-0.5 rounded-lg bg-destructive/10 text-destructive text-[10px] font-bold">
              {lives!.length}
            </span>
          )}
        </div>
        <Link to="/lives" className="text-[11px] text-primary/70 font-semibold hover:text-primary transition-colors uppercase tracking-wider">
          Voir tout
        </Link>
      </div>

      <div className="px-3 pb-3">
        <ScrollArea className="w-full">
          <div className="flex gap-2.5 pb-1">
            {allItems.map((item) => (
              <LiveCard key={item.id} item={item} />
            ))}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </div>
    </article>
  );
}
