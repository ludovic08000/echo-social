import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export interface RestrictedFriend {
  id: string;
  user_id: string;
  restricted_user_id: string;
  restrict_feed: boolean;
  restrict_stories: boolean;
  restrict_messages: boolean;
  restrict_profile: boolean;
  created_at: string;
}

export function useRestrictedFriends() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['restricted-friends', user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase
        .from('restricted_friends' as any)
        .select('*')
        .eq('user_id', user.id);
      if (error) throw error;
      return (data || []) as unknown as RestrictedFriend[];
    },
    enabled: !!user,
  });
}

export function useAddRestrictedFriend() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (restrictedUserId: string) => {
      if (!user) throw new Error('Not authenticated');
      const { error } = await supabase
        .from('restricted_friends' as any)
        .insert({ user_id: user.id, restricted_user_id: restrictedUserId } as any);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['restricted-friends', user?.id] });
    },
  });
}

export function useUpdateRestrictedFriend() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Partial<Pick<RestrictedFriend, 'restrict_feed' | 'restrict_stories' | 'restrict_messages' | 'restrict_profile'>> }) => {
      if (!user) throw new Error('Not authenticated');
      const { error } = await supabase
        .from('restricted_friends' as any)
        .update(updates as any)
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['restricted-friends', user?.id] });
    },
  });
}

export function useRemoveRestrictedFriend() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (id: string) => {
      if (!user) throw new Error('Not authenticated');
      const { error } = await supabase
        .from('restricted_friends' as any)
        .delete()
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['restricted-friends', user?.id] });
    },
  });
}
