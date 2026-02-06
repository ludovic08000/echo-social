import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export interface Challenge {
  id: string;
  title: string;
  description: string | null;
  challenge_type: string;
  image_url: string | null;
  starts_at: string;
  ends_at: string;
  creator_id: string;
  created_at: string;
  creator_profile?: { name: string; avatar_url: string | null };
  participants_count: number;
  is_joined: boolean;
}

export function useChallenges() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['challenges'],
    queryFn: async () => {
      const { data: challenges, error } = await supabase
        .from('challenges')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;

      const creatorIds = [...new Set(challenges.map(c => c.creator_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', creatorIds);
      const profileMap = new Map(profiles?.map(p => [p.user_id, p]) || []);

      const challengeIds = challenges.map(c => c.id);
      const { data: participants } = await supabase
        .from('challenge_participants')
        .select('challenge_id, user_id')
        .in('challenge_id', challengeIds);

      const countMap: Record<string, number> = {};
      const joinedSet = new Set<string>();
      participants?.forEach(p => {
        countMap[p.challenge_id] = (countMap[p.challenge_id] || 0) + 1;
        if (p.user_id === user?.id) joinedSet.add(p.challenge_id);
      });

      return challenges.map(c => ({
        ...c,
        creator_profile: profileMap.get(c.creator_id) || { name: 'Unknown', avatar_url: null },
        participants_count: countMap[c.id] || 0,
        is_joined: joinedSet.has(c.id),
      })) as Challenge[];
    },
    enabled: !!user,
  });
}

export function useCreateChallenge() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (data: { title: string; description?: string; challenge_type: string; ends_at: string }) => {
      if (!user) throw new Error('Not authenticated');
      const { data: challenge, error } = await supabase
        .from('challenges')
        .insert({ ...data, creator_id: user.id })
        .select()
        .single();
      if (error) throw error;
      return challenge;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['challenges'] });
    },
  });
}

export function useJoinChallenge() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (challengeId: string) => {
      if (!user) throw new Error('Not authenticated');
      const { error } = await supabase
        .from('challenge_participants')
        .insert({ challenge_id: challengeId, user_id: user.id });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['challenges'] });
    },
  });
}

export function useLeaveChallenge() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (challengeId: string) => {
      if (!user) throw new Error('Not authenticated');
      const { error } = await supabase
        .from('challenge_participants')
        .delete()
        .eq('challenge_id', challengeId)
        .eq('user_id', user.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['challenges'] });
    },
  });
}
