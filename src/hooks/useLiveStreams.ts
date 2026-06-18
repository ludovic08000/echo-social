import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { useEffect } from 'react';

export interface LiveStream {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  thumbnail_url: string | null;
  is_active: boolean;
  viewer_count: number;
  peak_viewer_count: number;
  total_views: number;
  category: string;
  hashtags: string[];
  started_at: string | null;
  recording_url: string | null;
  created_at: string;
  // Joined data
  host?: {
    name: string;
    avatar_url: string | null;
  };
}

export interface LiveChatMessage {
  id: string;
  user_id: string;
  live_id: string;
  message: string;
  is_gift: boolean;
  gift_type: string | null;
  created_at: string;
  // Joined
  sender?: {
    name: string;
    avatar_url: string | null;
  };
}

// Calcul du score de pertinence pour les lives
function calculateLiveScore(
  live: any,
  userInterests: string[],
  followingIds: string[]
): number {
  let score = 0;

  // 1. Nombre de viewers actuels (popularité en temps réel)
  const viewerScore = Math.min(1, live.viewer_count / 1000);
  score += viewerScore * 0.35;

  // 2. Créateur suivi = boost important
  if (followingIds.includes(live.user_id)) {
    score += 0.40;
  }

  // 3. Correspondance des intérêts
  const liveHashtags = live.hashtags || [];
  const matchingInterests = liveHashtags.filter((tag: string) =>
    userInterests.some(interest =>
      tag.toLowerCase().includes(interest.toLowerCase())
    )
  );
  const interestScore = Math.min(1, matchingInterests.length / Math.max(1, liveHashtags.length));
  score += interestScore * 0.20;

  // 4. Fraîcheur (lives qui viennent de commencer)
  if (live.started_at) {
    const startedMinutesAgo = (Date.now() - new Date(live.started_at).getTime()) / (1000 * 60);
    if (startedMinutesAgo < 10) {
      score += 0.15; // Boost pour les nouveaux lives
    }
  }

  // 5. Un peu de randomisation
  score += Math.random() * 0.05;

  return Math.max(0, Math.min(1, score));
}

async function fetchLiveServerOrder(userId: string): Promise<string[] | null> {
  if (!userId) return null;
  try {
    const { data, error } = await (supabase.rpc as any)('live_score_batch', {
      p_user_id: userId,
      p_limit: 80,
    });
    if (error || !Array.isArray(data) || data.length === 0) return null;
    return data.map((row: any) => row.live_id).filter(Boolean);
  } catch {
    return null;
  }
}

function orderLivesByIds<T extends { id: string }>(lives: T[], orderedIds: string[] | null): T[] {
  if (!orderedIds?.length) return lives;
  const byId = new Map(lives.map(live => [live.id, live]));
  const seen = new Set<string>();
  const ordered: T[] = [];
  for (const id of orderedIds) {
    const live = byId.get(id);
    if (live) {
      ordered.push(live);
      seen.add(id);
    }
  }
  for (const live of lives) {
    if (!seen.has(live.id)) ordered.push(live);
  }
  return ordered;
}

export function useLiveStreams() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['live-streams', user?.id],
    queryFn: async () => {
      // 1. Récupérer les lives actifs
      const { data: lives, error } = await supabase
        .from('live_streams')
        .select('id,user_id,title,description,thumbnail_url,is_active,viewer_count,peak_viewer_count,total_views,category,hashtags,started_at,recording_url,created_at')
        .eq('is_active', true)
        .order('viewer_count', { ascending: false });

      if (error) throw error;
      if (!lives || lives.length === 0) return [];

      const orderedIds = user ? await fetchLiveServerOrder(user.id) : null;
      const serverOrderedLives = orderLivesByIds(lives, orderedIds);

      // 2. Récupérer les profils des hosts
      const hostIds = [...new Set(lives.map(l => l.user_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', hostIds);

      const profileMap = new Map(
        (profiles || []).map(p => [p.user_id, { name: p.name, avatar_url: p.avatar_url }])
      );

      // 3. Si connecté, appliquer l'algorithme
      if (user) {
        if (orderedIds) {
          return serverOrderedLives.map(live => ({
            ...live,
            host: profileMap.get(live.user_id),
          })) as LiveStream[];
        }

        const { data: interests } = await supabase
          .from('user_interests')
          .select('interest_value')
          .eq('user_id', user.id);

        const userInterests = (interests || []).map(i => i.interest_value);

        const { data: friendships } = await supabase
          .from('friendships')
          .select('requester_id, addressee_id')
          .eq('status', 'accepted')
          .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`);

        const followingIds = (friendships || []).map(f =>
          f.requester_id === user.id ? f.addressee_id : f.requester_id
        );

        // Score et tri
        const scoredLives = lives.map(live => ({
          ...live,
          host: profileMap.get(live.user_id),
          _score: calculateLiveScore(live, userInterests, followingIds)
        }));

        scoredLives.sort((a, b) => b._score - a._score);

        return scoredLives.map(({ _score, ...live }) => live) as LiveStream[];
      }

      // Non connecté: tri par viewers
      return lives.map(live => ({
        ...live,
        host: profileMap.get(live.user_id),
      })) as LiveStream[];
    },
    refetchInterval: 60_000, // Refresh every 60s (was 10s — too aggressive for mobile)
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useLiveStream(liveId: string | undefined) {
  return useQuery({
    queryKey: ['live-stream', liveId],
    queryFn: async () => {
      if (!liveId) return null;

      const { data, error } = await supabase
        .from('live_streams')
        .select('*')
        .eq('id', liveId)
        .single();

      if (error) throw error;

      // Get host profile
      const { data: profile } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .eq('user_id', data.user_id)
        .single();

      return {
        ...data,
        host: profile ? { name: profile.name, avatar_url: profile.avatar_url } : undefined
      } as LiveStream;
    },
    enabled: !!liveId,
    refetchInterval: 5000,
  });
}

export function useLiveChat(liveId: string | undefined) {
  const queryClient = useQueryClient();

  // Subscribe to realtime chat
  useEffect(() => {
    if (!liveId) return;

    const channel = supabase
      .channel(`live-chat-${liveId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'live_chat',
          filter: `live_id=eq.${liveId}`,
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ['live-chat', liveId] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [liveId, queryClient]);

  return useQuery({
    queryKey: ['live-chat', liveId],
    queryFn: async () => {
      if (!liveId) return [];

      const { data, error } = await supabase
        .from('live_chat')
        .select('*')
        .eq('live_id', liveId)
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) throw error;

      // Get sender profiles
      const senderIds = [...new Set((data || []).map(m => m.user_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', senderIds);

      const profileMap = new Map(
        (profiles || []).map(p => [p.user_id, { name: p.name, avatar_url: p.avatar_url }])
      );

      return (data || []).map(msg => ({
        ...msg,
        sender: profileMap.get(msg.user_id),
      })).reverse() as LiveChatMessage[];
    },
    enabled: !!liveId,
  });
}

export function useSendLiveChatMessage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ liveId, message }: { liveId: string; message: string }) => {
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('live_chat')
        .insert({
          user_id: user.id,
          live_id: liveId,
          message,
        });

      if (error) throw error;
    },
    onSuccess: (_, { liveId }) => {
      queryClient.invalidateQueries({ queryKey: ['live-chat', liveId] });
    },
  });
}

export function useJoinLive() {
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (liveId: string) => {
      if (!user) return;

      await supabase
        .from('live_views')
        .insert({
          user_id: user.id,
          live_id: liveId,
        });
    },
  });
}

export function useLeaveLive() {
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ liveId, watchTimeSeconds }: { liveId: string; watchTimeSeconds: number }) => {
      if (!user) return;

      await supabase
        .from('live_views')
        .update({
          left_at: new Date().toISOString(),
          watch_time_seconds: watchTimeSeconds,
        })
        .eq('user_id', user.id)
        .eq('live_id', liveId)
        .is('left_at', null);
    },
  });
}

export function useStartLive() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ title, description, category, hashtags }: {
      title: string;
      description?: string;
      category?: string;
      hashtags?: string[];
    }) => {
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('live_streams')
        .insert({
          user_id: user.id,
          title,
          description,
          category: category || 'general',
          hashtags: hashtags || [],
          is_active: true,
          started_at: new Date().toISOString(),
          stream_key: crypto.randomUUID(),
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['live-streams'] });
    },
  });
}

export function useEndLive() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (liveId: string) => {
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('live_streams')
        .update({
          is_active: false,
          ended_at: new Date().toISOString(),
        })
        .eq('id', liveId)
        .eq('user_id', user.id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['live-streams'] });
    },
  });
}

export function useDeleteLive() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (liveId: string) => {
      if (!user) throw new Error('Not authenticated');

      // Get recording URL to delete from storage
      const { data: live } = await supabase
        .from('live_streams')
        .select('recording_url')
        .eq('id', liveId)
        .eq('user_id', user.id)
        .single();

      if (live?.recording_url) {
        try {
          const { deleteFromR2 } = await import('@/lib/r2');
          // Extract R2 path from full URL
          const r2PublicUrl = live.recording_url;
          const pathMatch = r2PublicUrl.match(/lives\/[^?]+/);
          if (pathMatch) {
            await deleteFromR2(pathMatch[0]);
          }
        } catch (e) {
          console.error('R2 delete error:', e);
        }
      }

      // Delete related data
      await supabase.from('live_chat').delete().eq('live_id', liveId);
      await supabase.from('live_views').delete().eq('live_id', liveId);

      const { error } = await supabase
        .from('live_streams')
        .delete()
        .eq('id', liveId)
        .eq('user_id', user.id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['live-streams'] });
      queryClient.invalidateQueries({ queryKey: ['recent-replays'] });
    },
  });
}
