import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export interface ShortVideo {
  id: string;
  user_id: string;
  video_url: string;
  thumbnail_url: string | null;
  caption: string | null;
  duration_seconds: number;
  hashtags: string[];
  sound_name: string | null;
  view_count: number;
  like_count: number;
  comment_count: number;
  share_count: number;
  created_at: string;
  // Joined data
  author?: {
    name: string;
    avatar_url: string | null;
  };
  // Computed for current user
  is_liked?: boolean;
  is_saved?: boolean;
}

function fallbackVideoScore(video: any): number {
  const ageHours = Math.max(0.1, (Date.now() - new Date(video.created_at).getTime()) / 3_600_000);
  const engagement = Math.log1p(
    (video.like_count || 0) * 1.5 +
    (video.comment_count || 0) * 3 +
    (video.share_count || 0) * 4 +
    (video.view_count || 0) * 0.05
  ) / Math.log(200);
  const recency = Math.pow(0.5, ageHours / 24);
  const coldStart = ageHours < 12 && ((video.view_count || 0) + (video.like_count || 0)) < 10 ? 0.12 : 0;
  return Math.max(0, Math.min(1, engagement * 0.55 + recency * 0.33 + coldStart));
}

export function useVideoFeed(limit: number = 10) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['video-feed', user?.id, limit],
    queryFn: async () => {
      if (!user) return [];

      const lightweightMode = limit <= 6;
      const poolSize = lightweightMode ? Math.max(limit * 4, 16) : Math.min(60, Math.max(limit * 5, 24));

      // 1. Récupérer les vidéos
      const { data: videos, error: videosError } = await supabase
        .from('short_videos')
        .select('*')
        .eq('is_public', true)
        .order('created_at', { ascending: false })
        .limit(poolSize);

      if (videosError) throw videosError;
      if (!videos || videos.length === 0) return [];

      const videoIds = videos.map(v => v.id);
      const authorIds = [...new Set(videos.map(v => v.user_id))];
      const [profilesRes, userLikesRes, userSavesRes, serverScoreRes] = await Promise.all([
        supabase
          .from('profiles')
          .select('user_id, name, avatar_url')
          .in('user_id', authorIds),
        lightweightMode
          ? Promise.resolve({ data: [] as Array<{ video_id: string }> })
          : supabase.from('video_likes').select('video_id').eq('user_id', user.id).in('video_id', videoIds),
        lightweightMode
          ? Promise.resolve({ data: [] as Array<{ video_id: string }> })
          : supabase.from('video_saves').select('video_id').eq('user_id', user.id).in('video_id', videoIds),
        (supabase.rpc as any)('video_score_batch', {
          p_user_id: user.id,
          p_video_ids: videoIds,
        }).catch((error: unknown) => ({ data: null, error })),
      ]);

      const profileMap = new Map(
        (profilesRes.data || []).map(p => [p.user_id, { name: p.name, avatar_url: p.avatar_url }])
      );
      const likedVideoIds = new Set((userLikesRes.data || []).map(l => l.video_id));
      const savedVideoIds = new Set((userSavesRes.data || []).map(s => s.video_id));
      const serverScores = Array.isArray((serverScoreRes as any).data) ? (serverScoreRes as any).data : [];
      const scoreMap = new Map<string, number>(
        serverScores.map((r: any) => [String(r.video_id), Number(r.score) || 0])
      );

      const decorated = videos.map(video => ({
        ...video,
        author: profileMap.get(video.user_id),
        is_liked: likedVideoIds.has(video.id),
        is_saved: savedVideoIds.has(video.id),
      }));

      const sorted = [...decorated].sort((a, b) => {
        const aScore = scoreMap.get(a.id) ?? fallbackVideoScore(a);
        const bScore = scoreMap.get(b.id) ?? fallbackVideoScore(b);
        if (bScore !== aScore) return bScore - aScore;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });

      return sorted.slice(0, limit) as ShortVideo[];

    },
    enabled: !!user,
    staleTime: 2 * 60_000,   // 2 min cache — videos don't change fast
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
}

// Hook pour enregistrer une vue
export function useRecordVideoView() {
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ 
      videoId, 
      watchTimeSeconds, 
      completionRate,
      replayed = false,
      source = 'feed'
    }: { 
      videoId: string; 
      watchTimeSeconds: number; 
      completionRate: number;
      replayed?: boolean;
      source?: string;
    }) => {
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('video_views')
        .insert({
          user_id: user.id,
          video_id: videoId,
          watch_time_seconds: watchTimeSeconds,
          completion_rate: completionRate,
          replayed,
          source,
        });

      if (error) throw error;

      const signalType =
        completionRate >= 0.9 ? 'watch_complete' :
        completionRate >= 0.55 ? 'dwell_long' :
        completionRate < 0.2 ? 'skip_fast' :
        'dwell_medium';

      try {
        await supabase.from('ml_interactions').insert({
          user_id: user.id,
          post_id: videoId,
          signal_type: signalType,
          weight: signalType === 'skip_fast' ? -1 : signalType === 'watch_complete' ? 2.2 : 1.2,
          dwell_ms: Math.max(0, Math.round(watchTimeSeconds * 1000)),
          scroll_depth: Math.max(0, Math.min(1, completionRate)),
        });
      } catch {
        // video_views remains the source of truth if an older schema rejects this row.
      }

      // Mettre à jour les intérêts de l'utilisateur basé sur le visionnage
      if (completionRate > 0.5) {
        // Si l'utilisateur a regardé plus de 50%, inférer un intérêt
        const { data: video } = await supabase
          .from('short_videos')
          .select('hashtags')
          .eq('id', videoId)
          .single();

        if (video?.hashtags && video.hashtags.length > 0) {
          await supabase
            .from('user_interests')
            .upsert(
              video.hashtags.slice(0, 12).map((hashtag: string) => ({
                user_id: user.id,
                interest_type: 'hashtag',
                interest_value: hashtag,
                weight: Math.min(5, completionRate * 2),
                explicit: false,
              })),
              {
                onConflict: 'user_id,interest_type,interest_value',
              }
            );
        }
      }
    },
    onSuccess: () => {
      // Ne pas invalider ici: chaque vue/replay peut spammer le refresh et rendre iPhone instable
    },
  });
}

// Hook pour liker une vidéo
export function useToggleVideoLike() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ videoId, isLiked }: { videoId: string; isLiked: boolean }) => {
      if (!user) throw new Error('Not authenticated');

      if (isLiked) {
        await supabase
          .from('video_likes')
          .delete()
          .eq('user_id', user.id)
          .eq('video_id', videoId);
      } else {
        await supabase
          .from('video_likes')
          .insert({ user_id: user.id, video_id: videoId });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['video-feed'] });
    },
  });
}

// Hook pour sauvegarder une vidéo
export function useToggleVideoSave() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ videoId, isSaved }: { videoId: string; isSaved: boolean }) => {
      if (!user) throw new Error('Not authenticated');

      if (isSaved) {
        await supabase
          .from('video_saves')
          .delete()
          .eq('user_id', user.id)
          .eq('video_id', videoId);
      } else {
        await supabase
          .from('video_saves')
          .insert({ user_id: user.id, video_id: videoId });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['video-feed'] });
    },
  });
}

// Hook pour partager une vidéo
export function useShareVideo() {
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ videoId, shareType = 'copy_link' }: { videoId: string; shareType?: string }) => {
      if (!user) throw new Error('Not authenticated');

      await supabase
        .from('video_shares')
        .insert({ user_id: user.id, video_id: videoId, share_type: shareType });
    },
  });
}
