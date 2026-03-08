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

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Radio className={`w-4 h-4 ${hasLives ? 'text-destructive animate-pulse' : 'text-muted-foreground'}`} />
          <h3 className="font-semibold text-sm">
            {hasLives ? 'En direct' : 'Replays récents'}
          </h3>
          {hasLives && (
            <span className="px-1.5 py-0.5 rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold">
              {lives!.length}
            </span>
          )}
        </div>
        <Link to="/lives" className="text-xs text-primary font-medium">
          Voir tout
        </Link>
      </div>

      <ScrollArea className="w-full whitespace-nowrap">
        <div className="flex gap-3 pb-2">
          {/* Active lives first */}
          {hasLives && lives!.slice(0, 6).map((live) => (
            <Link
              key={live.id}
              to={`/live/${live.id}`}
              className="flex-shrink-0 w-[130px] rounded-2xl overflow-hidden bg-black group relative aspect-[9/16]"
            >
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

              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors duration-300" />
            </Link>
          ))}

          {/* Replays */}
          {hasReplays && replays!.map((replay) => (
            <Link
              key={replay.id}
              to={`/live/${replay.id}`}
              className="flex-shrink-0 w-[130px] rounded-2xl overflow-hidden bg-black group relative aspect-[9/16]"
            >
              {replay.thumbnail_url ? (
                <img
                  src={replay.thumbnail_url}
                  alt={replay.title}
                  className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                />
              ) : (
                <div className="absolute inset-0 bg-gradient-to-br from-primary/20 via-black to-muted/20 flex items-center justify-center">
                  <div className="w-12 h-12 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center">
                    <Play className="w-5 h-5 text-white ml-0.5" />
                  </div>
                </div>
              )}

              <div className="absolute top-2 left-2 right-2 flex items-center justify-between z-10">
                <span className="px-2 py-0.5 rounded-full bg-secondary/80 backdrop-blur-sm text-foreground text-[10px] font-medium flex items-center gap-1">
                  <Clock className="w-2.5 h-2.5" />
                  Replay
                </span>
                <div className="flex items-center gap-1">
                  {user && user.id === replay.user_id && (
                    <button
                      onClick={(e) => handleDelete(e, replay.id)}
                      className="p-1 rounded-full bg-black/60 backdrop-blur-sm text-white hover:bg-destructive transition-colors"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                  {replay.total_views > 0 && (
                    <span className="px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-sm text-white text-[10px] flex items-center gap-1">
                      <Eye className="w-2.5 h-2.5" />
                      {replay.total_views}
                    </span>
                  )}
                </div>
              </div>

              <div className="absolute bottom-0 left-0 right-0 p-2.5 bg-gradient-to-t from-black/90 via-black/50 to-transparent z-10">
                <div className="flex items-center gap-2 mb-1">
                  <UserAvatar src={replay.host?.avatar_url} alt={replay.host?.name} size="xs" />
                  <p className="text-white text-[11px] font-semibold truncate">{replay.host?.name}</p>
                </div>
                <p className="text-white/80 text-[10px] truncate whitespace-normal line-clamp-2 leading-snug">{replay.title}</p>
                {replay.ended_at && (
                  <p className="text-white/50 text-[9px] mt-0.5">
                    {formatDistanceToNow(new Date(replay.ended_at), { addSuffix: true, locale: fr })}
                  </p>
                )}
              </div>

              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors duration-300" />
            </Link>
          ))}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  );
}
