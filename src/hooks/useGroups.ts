import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export interface Group {
  id: string;
  name: string;
  description: string | null;
  privacy: 'public' | 'private';
  cover_image_url: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  member_count?: number;
  is_member?: boolean;
  is_admin?: boolean;
}

export interface GroupMember {
  id: string;
  user_id: string;
  group_id: string;
  role: string;
  joined_at: string;
  profile?: {
    name: string;
    avatar_url: string | null;
  };
}

export function useGroups() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['groups'],
    queryFn: async (): Promise<Group[]> => {
      const { data: groups, error } = await supabase
        .from('groups')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;

      // Get member counts and membership status
      const groupsWithStats = await Promise.all(
        (groups || []).map(async (group) => {
          const [{ count: memberCount }, { data: membership }] = await Promise.all([
            supabase
              .from('group_members')
              .select('*', { count: 'exact', head: true })
              .eq('group_id', group.id),
            user
              ? supabase
                  .from('group_members')
                  .select('role')
                  .eq('group_id', group.id)
                  .eq('user_id', user.id)
                  .maybeSingle()
              : Promise.resolve({ data: null }),
          ]);

          return {
            ...group,
            privacy: group.privacy as 'public' | 'private',
            member_count: memberCount || 0,
            is_member: !!membership,
            is_admin: membership?.role === 'admin',
          };
        })
      );

      return groupsWithStats;
    },
  });
}

export function useMyGroups() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['my-groups', user?.id],
    queryFn: async (): Promise<Group[]> => {
      if (!user) return [];

      const { data: memberships, error } = await supabase
        .from('group_members')
        .select('group_id, role')
        .eq('user_id', user.id);

      if (error) throw error;
      if (!memberships || memberships.length === 0) return [];

      const groupIds = memberships.map((m) => m.group_id);

      const { data: groups } = await supabase
        .from('groups')
        .select('*')
        .in('id', groupIds)
        .order('created_at', { ascending: false });

      const membershipMap = new Map(memberships.map((m) => [m.group_id, m.role]));

      return (groups || []).map((group) => ({
        ...group,
        privacy: group.privacy as 'public' | 'private',
        is_member: true,
        is_admin: membershipMap.get(group.id) === 'admin',
      }));
    },
    enabled: !!user,
  });
}

export function useGroup(groupId: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['group', groupId],
    queryFn: async (): Promise<Group | null> => {
      const { data: group, error } = await supabase
        .from('groups')
        .select('*')
        .eq('id', groupId)
        .single();

      if (error) throw error;

      const [{ count: memberCount }, { data: membership }] = await Promise.all([
        supabase
          .from('group_members')
          .select('*', { count: 'exact', head: true })
          .eq('group_id', groupId),
        user
          ? supabase
              .from('group_members')
              .select('role')
              .eq('group_id', groupId)
              .eq('user_id', user.id)
              .maybeSingle()
          : Promise.resolve({ data: null }),
      ]);

      return {
        ...group,
        privacy: group.privacy as 'public' | 'private',
        member_count: memberCount || 0,
        is_member: !!membership,
        is_admin: membership?.role === 'admin',
      };
    },
    enabled: !!groupId,
  });
}

export function useGroupMembers(groupId: string) {
  return useQuery({
    queryKey: ['group-members', groupId],
    queryFn: async (): Promise<GroupMember[]> => {
      const { data: members, error } = await supabase
        .from('group_members')
        .select('*')
        .eq('group_id', groupId)
        .order('joined_at', { ascending: true });

      if (error) throw error;
      if (!members || members.length === 0) return [];

      const userIds = members.map((m) => m.user_id);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', userIds);

      const profileMap = new Map(profiles?.map((p) => [p.user_id, p]) || []);

      return members.map((member) => ({
        ...member,
        profile: profileMap.get(member.user_id),
      }));
    },
    enabled: !!groupId,
  });
}

export function useCreateGroup() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({
      name,
      description,
      privacy,
      cover_image_url,
    }: {
      name: string;
      description?: string;
      privacy: 'public' | 'private';
      cover_image_url?: string;
    }) => {
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('groups')
        .insert({
          name,
          description: description || null,
          privacy,
          cover_image_url: cover_image_url || null,
          created_by: user.id,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      queryClient.invalidateQueries({ queryKey: ['my-groups'] });
    },
  });
}

export function useJoinGroup() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (groupId: string) => {
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('group_members')
        .insert({
          group_id: groupId,
          user_id: user.id,
          role: 'member',
        });

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      queryClient.invalidateQueries({ queryKey: ['my-groups'] });
      queryClient.invalidateQueries({ queryKey: ['group'] });
    },
  });
}

export function useLeaveGroup() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (groupId: string) => {
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase
        .from('group_members')
        .delete()
        .eq('group_id', groupId)
        .eq('user_id', user.id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      queryClient.invalidateQueries({ queryKey: ['my-groups'] });
      queryClient.invalidateQueries({ queryKey: ['group'] });
    },
  });
}
