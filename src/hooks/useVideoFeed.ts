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

interface AlgorithmWeights {
  watchTime: number;      // Poids du temps de visionnage
  completion: number;     // Poids du taux de complétion
  likes: number;          // Poids des likes
  comments: number;       // Poids des commentaires
  shares: number;         // Poids des partages
  saves: number;          // Poids des sauvegardes
  recency: number;        // Poids de la fraîcheur
  following: number;      // Poids des créateurs suivis
  interests: number;      // Poids des intérêts
  discovery: number;      // Poids de la découverte
}

// Poids de l'algorithme TikTok-like (équilibré)
const ALGORITHM_WEIGHTS: AlgorithmWeights = {
  watchTime: 0.25,      // Le temps de visionnage est crucial
  completion: 0.20,     // Regarder jusqu'au bout = très intéressant
  likes: 0.10,          // Les likes sont importants mais pas tout
  comments: 0.12,       // Les commentaires montrent l'engagement
  shares: 0.15,         // Les partages = viralité
  saves: 0.08,          // Les sauvegardes = valeur long terme
  recency: 0.05,        // Un peu de fraîcheur
  following: 0.25,      // Contenu des personnes suivies
  interests: 0.20,      // Intérêts de l'utilisateur
  discovery: 0.15,      // Découverte de nouveau contenu
};

// Calcule le score de pertinence d'une vidéo pour un utilisateur
function calculateRelevanceScore(
  video: any,
  userInterests: string[],
  followingIds: string[],
  viewHistory: Map<string, { watchTime: number; completion: number }>
): number {
  let score = 0;

  // 1. Engagement global de la vidéo (normaliser entre 0 et 1)
  const engagementScore = Math.min(1, (
    (video.like_count * 0.3) +
    (video.comment_count * 0.4) +
    (video.share_count * 0.5)
  ) / 1000);
  score += engagementScore * ALGORITHM_WEIGHTS.likes;

  // 2. Fraîcheur (videos récentes = boost)
  const ageHours = (Date.now() - new Date(video.created_at).getTime()) / (1000 * 60 * 60);
  const recencyScore = Math.max(0, 1 - (ageHours / 168)); // Décroît sur 7 jours
  score += recencyScore * ALGORITHM_WEIGHTS.recency;

  // 3. Créateur suivi
  if (followingIds.includes(video.user_id)) {
    score += ALGORITHM_WEIGHTS.following;
  }

  // 4. Correspondance des intérêts
  const videoHashtags = video.hashtags || [];
  const matchingInterests = videoHashtags.filter((tag: string) => 
    userInterests.some(interest => 
      tag.toLowerCase().includes(interest.toLowerCase()) ||
      interest.toLowerCase().includes(tag.toLowerCase())
    )
  );
  const interestScore = Math.min(1, matchingInterests.length / Math.max(1, videoHashtags.length));
  score += interestScore * ALGORITHM_WEIGHTS.interests;

  // 5. Historique de visionnage similaire
  const viewData = viewHistory.get(video.id);
  if (viewData) {
    // Pénaliser légèrement le contenu déjà vu, sauf si replay
    score -= 0.1;
  }

  // 6. Bonus découverte (créateurs pas encore suivis avec bon engagement)
  if (!followingIds.includes(video.user_id) && engagementScore > 0.3) {
    score += ALGORITHM_WEIGHTS.discovery * engagementScore;
  }

  // 7. Ajouter un peu de randomisation pour éviter les bulles de filtre
  score += (Math.random() * 0.1);

  return Math.max(0, Math.min(1, score));
}

export function useVideoFeed(limit: number = 10) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['video-feed', user?.id, limit],
    queryFn: async () => {
      if (!user) return [];

      const lightweightMode = limit <= 6;
      const poolSize = lightweightMode ? Math.max(limit, 6) : Math.min(40, Math.max(limit * 4, 16));

      // 1. Récupérer les vidéos
      const { data: videos, error: videosError } = await supabase
        .from('short_videos')
        .select('*')
        .eq('is_public', true)
        .order('created_at', { ascending: false })
        .limit(poolSize);

      if (videosError) throw videosError;
      if (!videos || videos.length === 0) return [];

      // Mode léger (iPhone/feed): éviter les requêtes algorithmiques coûteuses
      if (lightweightMode) {
        const authorIds = [...new Set(videos.map(v => v.user_id))];
        const { data: profiles } = await supabase
          .from('profiles')
          .select('user_id, name, avatar_url')
          .in('user_id', authorIds);

        const profileMap = new Map(
          (profiles || []).map(p => [p.user_id, { name: p.name, avatar_url: p.avatar_url }])
        );

        return videos.slice(0, limit).map(video => ({
          ...video,
          author: profileMap.get(video.user_id),
          is_liked: false,
          is_saved: false,
        })) as ShortVideo[];
      }
      // 2. Récupérer les intérêts de l'utilisateur
      const { data: interests } = await supabase
        .from('user_interests')
        .select('interest_value, weight')
        .eq('user_id', user.id)
        .order('weight', { ascending: false })
        .limit(20);

      const userInterests = (interests || []).map(i => i.interest_value);

      // 3. Récupérer les créateurs suivis (via friendships)
      const { data: friendships } = await supabase
        .from('friendships')
        .select('requester_id, addressee_id')
        .eq('status', 'accepted')
        .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`);

      const followingIds = (friendships || []).map(f => 
        f.requester_id === user.id ? f.addressee_id : f.requester_id
      );

      // 4. Récupérer l'historique de visionnage récent
      const { data: viewHistory } = await supabase
        .from('video_views')
        .select('video_id, watch_time_seconds, completion_rate')
        .eq('user_id', user.id)
        .order('viewed_at', { ascending: false })
        .limit(100);

      const viewMap = new Map(
        (viewHistory || []).map(v => [v.video_id, { 
          watchTime: v.watch_time_seconds, 
          completion: Number(v.completion_rate) 
        }])
      );

      // 5. Récupérer les likes de l'utilisateur
      const videoIds = videos.map(v => v.id);
      const { data: userLikes } = await supabase
        .from('video_likes')
        .select('video_id')
        .eq('user_id', user.id)
        .in('video_id', videoIds);

      const likedVideoIds = new Set((userLikes || []).map(l => l.video_id));

      // 6. Récupérer les sauvegardes de l'utilisateur
      const { data: userSaves } = await supabase
        .from('video_saves')
        .select('video_id')
        .eq('user_id', user.id)
        .in('video_id', videoIds);

      const savedVideoIds = new Set((userSaves || []).map(s => s.video_id));

      // 7. Récupérer les profils des auteurs
      const authorIds = [...new Set(videos.map(v => v.user_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', authorIds);

      const profileMap = new Map(
        (profiles || []).map(p => [p.user_id, { name: p.name, avatar_url: p.avatar_url }])
      );

      // 8. Server-side ranking (anti-cheat). Fallback to client scoring on error.
      let orderedIds: string[] | null = null;
      try {
        const { data: serverScores, error: rpcErr } = await (supabase.rpc as any)('video_score_batch', {
          p_user_id: user.id,
          p_video_ids: videos.map(v => v.id),
        });
        if (!rpcErr && Array.isArray(serverScores) && serverScores.length > 0) {
          orderedIds = serverScores.map((r: any) => r.video_id);
        }
      } catch {
        // silent fallback
      }

      const decorated = videos.map(video => ({
        ...video,
        author: profileMap.get(video.user_id),
        is_liked: likedVideoIds.has(video.id),
        is_saved: savedVideoIds.has(video.id),
      }));

      let sorted: any[];
      if (orderedIds) {
        const byId = new Map(decorated.map(v => [v.id, v]));
        sorted = orderedIds.map(id => byId.get(id)).filter(Boolean) as any[];
        // append any not scored at the tail
        const seen = new Set(orderedIds);
        for (const v of decorated) if (!seen.has(v.id)) sorted.push(v);
      } else {
        const scored = decorated.map(video => ({
          ...video,
          _score: calculateRelevanceScore(video, userInterests, followingIds, viewMap),
        }));
        scored.sort((a, b) => b._score - a._score);
        sorted = scored.map(({ _score, ...v }) => v);
      }

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

      // Mettre à jour les intérêts de l'utilisateur basé sur le visionnage
      if (completionRate > 0.5) {
        // Si l'utilisateur a regardé plus de 50%, inférer un intérêt
        const { data: video } = await supabase
          .from('short_videos')
          .select('hashtags')
          .eq('id', videoId)
          .single();

        if (video?.hashtags && video.hashtags.length > 0) {
          for (const hashtag of video.hashtags) {
            await supabase
              .from('user_interests')
              .upsert({
                user_id: user.id,
                interest_type: 'hashtag',
                interest_value: hashtag,
                weight: Math.min(5, completionRate * 2),
                explicit: false,
              }, { 
                onConflict: 'user_id,interest_type,interest_value',
              });
          }
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
