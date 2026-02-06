import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export interface WallMessage {
  id: string;
  author_id: string;
  target_user_id: string;
  message: string;
  is_approved: boolean;
  created_at: string;
}

export function useAnonymousWall(targetUserId: string) {
  return useQuery({
    queryKey: ['anonymous-wall', targetUserId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('anonymous_wall_messages')
        .select('*')
        .eq('target_user_id', targetUserId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as WallMessage[];
    },
    enabled: !!targetUserId,
  });
}

export function usePostWallMessage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ targetUserId, message }: { targetUserId: string; message: string }) => {
      if (!user) throw new Error('Not authenticated');
      const { data, error } = await supabase
        .from('anonymous_wall_messages')
        .insert({ author_id: user.id, target_user_id: targetUserId, message })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['anonymous-wall', variables.targetUserId] });
    },
  });
}

export function useApproveWallMessage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ id, approved }: { id: string; approved: boolean }) => {
      if (!user) throw new Error('Not authenticated');
      const { error } = await supabase
        .from('anonymous_wall_messages')
        .update({ is_approved: approved })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['anonymous-wall', user?.id] });
    },
  });
}

export function useDeleteWallMessage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (id: string) => {
      if (!user) throw new Error('Not authenticated');
      const { error } = await supabase
        .from('anonymous_wall_messages')
        .delete()
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['anonymous-wall', user?.id] });
    },
  });
}
