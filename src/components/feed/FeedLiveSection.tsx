import { Link } from 'react-router-dom';
import { Radio, Eye, Play, Clock, Trash2, Video } from 'lucide-react';
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
import { useRef, useCallback } from 'react';

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

// Mini video card that autoplays on hover
function LiveCard({ item }: { item: { id: string; title: string; thumbnail_url: string | null; recording_url?: string | null; isLive: boolean; viewer_count: number; user_id: string; ended_at: string | null; host?: { name: string; avatar_url: string | null } }; }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { user } = useAuth();
  const deleteLive = useDeleteLive();

  // Lazy-load video src on hover to save bandwidth
  const handleMouseEnter = useCallback(() => {
    const v = videoRef.current;
    if (v && item.recording_url) {
      if (!v.src || v.src === '') {
        v.src = item.recording_url;
      }
      v.play().catch(() => {});
    }
  }, [item.recording_url]);

  const handleMouseLeave = useCallback(() => {
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.currentTime = 0;
    }
  }, []);

  const handleDelete = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm('Supprimer ce replay ?')) return;
    deleteLive.mutate(item.id, {
      onSuccess: () => toast({ title: 'Replay supprimé' }),
    });
  };

  const hasVideo = !!item.recording_url;
  const hasThumbnail = !!item.thumbnail_url;

  return (
    <Link
      to={`/live/${item.id}`}
      className="relative flex-shrink-0 w-[110px] h-[160px] rounded-xl overflow-hidden bg-black group"
      onMouseEnter={() => videoRef.current?.play().catch(() => {})}
      onMouseLeave={() => { if (videoRef.current) { videoRef.current.pause(); videoRef.current.currentTime = 0; } }}
    >
      {/* Background: video preview > thumbnail > gradient placeholder */}
      {hasVideo ? (
        <video
          ref={videoRef}
          src={item.recording_url!}
          className="absolute inset-0 w-full h-full object-cover"
          muted
          loop
          playsInline
          preload="metadata"
          poster={item.thumbnail_url || undefined}
        />
      ) : hasThumbnail ? (
        <img
          src={item.thumbnail_url!}
          alt={item.title}
          loading="lazy"
          className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
        />
      ) : (
        <div className={cn(
          "absolute inset-0 flex flex-col items-center justify-center gap-2",
          item.isLive
            ? "bg-gradient-to-br from-destructive/30 via-destructive/10 to-black"
            : "bg-gradient-to-br from-primary/20 via-accent/10 to-black"
        )}>
          <div className="w-10 h-10 rounded-full bg-white/10 backdrop-blur flex items-center justify-center">
            {item.isLive ? (
              <Radio className="w-5 h-5 text-white animate-pulse" />
            ) : (
              <Video className="w-5 h-5 text-white/70" />
            )}
          </div>
          <UserAvatar src={item.host?.avatar_url} alt={item.host?.name} size="xs" />
        </div>
      )}

      {/* Darkened bottom gradient for text readability */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />

      {/* Top badge */}
      <div className="absolute top-1.5 left-1.5 right-1.5 flex items-center justify-between z-10">
        {item.isLive ? (
          <span className="px-1.5 py-0.5 rounded bg-destructive text-white text-[8px] font-bold flex items-center gap-0.5 shadow-lg">
            <Radio className="w-2 h-2 animate-pulse" />
            LIVE
          </span>
        ) : (
          <span className="px-1.5 py-0.5 rounded bg-black/50 backdrop-blur-sm text-white/80 text-[8px] font-medium flex items-center gap-0.5">
            <Clock className="w-2 h-2" />
            Replay
          </span>
        )}
        {!item.isLive && user?.id === item.user_id && (
          <button
            onClick={handleDelete}
            className="p-1 rounded bg-black/50 backdrop-blur-sm text-white/80 hover:bg-destructive transition-colors"
          >
            <Trash2 className="w-2.5 h-2.5" />
          </button>
        )}
      </div>

      {/* Viewers */}
      {item.viewer_count > 0 && (
        <div className="absolute top-1.5 right-1.5 z-10">
          <span className="px-1.5 py-0.5 rounded bg-black/50 backdrop-blur-sm text-white/80 text-[8px] flex items-center gap-0.5">
            <Eye className="w-2 h-2" />
            {item.viewer_count}
          </span>
        </div>
      )}

      {/* Bottom info */}
      <div className="absolute bottom-0 left-0 right-0 p-2 z-10">
        <div className="flex items-center gap-1.5 mb-0.5">
          {(hasVideo || hasThumbnail) && (
            <UserAvatar src={item.host?.avatar_url} alt={item.host?.name} size="xs" />
          )}
          <span className="text-white text-[9px] font-semibold truncate">
            {item.host?.name || 'Utilisateur'}
          </span>
        </div>
        <p className="text-white/70 text-[9px] line-clamp-2 leading-tight">{item.title}</p>
        {!item.isLive && item.ended_at && (
          <p className="text-white/40 text-[7px] mt-0.5">
            {formatDistanceToNow(new Date(item.ended_at), { addSuffix: true, locale: fr })}
          </p>
        )}
      </div>

      {/* Play icon overlay for videos */}
      {hasVideo && (
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10 pointer-events-none">
          <div className="w-8 h-8 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center">
            <Play className="w-4 h-4 text-white ml-0.5" />
          </div>
        </div>
      )}

      {/* Hover overlay */}
      <div className="absolute inset-0 bg-white/0 group-hover:bg-white/5 transition-colors" />
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
    <article className="bg-card border border-border/20 rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-destructive/10 flex items-center justify-center">
            <Radio className={cn("w-3.5 h-3.5", hasLives ? "text-destructive animate-pulse" : "text-muted-foreground")} />
          </div>
          <h3 className="text-sm font-semibold text-foreground">
            {hasLives ? 'En direct' : 'Replays'}
          </h3>
          {hasLives && (
            <span className="px-1.5 py-0.5 rounded-full bg-destructive/10 text-destructive text-[10px] font-bold">
              {lives!.length}
            </span>
          )}
        </div>
        <Link to="/lives" className="text-xs text-primary font-medium hover:text-primary/80 transition-colors">
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
