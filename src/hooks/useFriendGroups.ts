import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export interface FriendGroup {
  id: string;
  user_id: string;
  name: string;
  color: string;
  icon: string;
  created_at: string;
  updated_at: string;
  members?: FriendGroupMember[];
}

export interface FriendGroupMember {
  id: string;
  group_id: string;
  friend_user_id: string;
  added_at: string;
  profile?: {
    user_id: string;
    name: string;
    avatar_url: string | null;
  };
}

export function useFriendGroups() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['friend-groups'],
    queryFn: async (): Promise<FriendGroup[]> => {
      if (!user) return [];

      const { data: groups, error } = await supabase
        .from('friend_groups')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: true });

      if (error) throw error;

      // Get all members for all groups
      const groupIds = groups.map(g => g.id);
      if (groupIds.length === 0) {
        return groups.map(g => ({ ...g, members: [] })) as FriendGroup[];
      }

      const { data: members } = await supabase
        .from('friend_group_members')
        .select('*')
        .in('group_id', groupIds);

      // Get profiles for all members
      const memberUserIds = [...new Set(members?.map(m => m.friend_user_id) || [])];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', memberUserIds);

      const profileMap = new Map(profiles?.map(p => [p.user_id, p]) || []);

      // Attach members with profiles to groups
      return groups.map(group => ({
        ...group,
        members: members
          ?.filter(m => m.group_id === group.id)
          .map(m => ({
            ...m,
            profile: profileMap.get(m.friend_user_id),
          })) || [],
      })) as FriendGroup[];
    },
    enabled: !!user,
  });
}

export function useCreateFriendGroup() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ name, color = '#D4AF37', icon = 'users' }: { name: string; color?: string; icon?: string }) => {
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('friend_groups')
        .insert({
          user_id: user.id,
          name,
          color,
          icon,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['friend-groups'] });
    },
  });
}

export function useUpdateFriendGroup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, name, color, icon }: { id: string; name?: string; color?: string; icon?: string }) => {
      const updates: Record<string, string> = {};
      if (name) updates.name = name;
      if (color) updates.color = color;
      if (icon) updates.icon = icon;

      const { data, error } = await supabase
        .from('friend_groups')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['friend-groups'] });
    },
  });
}

export function useDeleteFriendGroup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (groupId: string) => {
      const { error } = await supabase
        .from('friend_groups')
        .delete()
        .eq('id', groupId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['friend-groups'] });
    },
  });
}

export function useAddToFriendGroup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ groupId, friendUserId }: { groupId: string; friendUserId: string }) => {
      const { data, error } = await supabase
        .from('friend_group_members')
        .insert({
          group_id: groupId,
          friend_user_id: friendUserId,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['friend-groups'] });
    },
  });
}

export function useRemoveFromFriendGroup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ groupId, friendUserId }: { groupId: string; friendUserId: string }) => {
      const { error } = await supabase
        .from('friend_group_members')
        .delete()
        .eq('group_id', groupId)
        .eq('friend_user_id', friendUserId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['friend-groups'] });
    },
  });
}
