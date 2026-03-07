import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export type FriendshipStatus = 'pending' | 'accepted' | 'rejected';

export interface Friendship {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: FriendshipStatus;
  created_at: string;
  profile: {
    user_id: string;
    name: string;
    avatar_url: string | null;
  };
}

export function useFriendships() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['friendships'],
    queryFn: async () => {
      if (!user) return { friends: [], pending: [], requests: [] };

      const { data, error } = await supabase
        .from('friendships')
        .select('*')
        .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`);

      if (error) throw error;

      // Get all related user profiles
      const userIds = [...new Set(data.flatMap(f => [f.requester_id, f.addressee_id]))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', userIds);

      const profileMap = new Map(profiles?.map(p => [p.user_id, p]) || []);

      const friends: Friendship[] = [];
      const pending: Friendship[] = [];
      const requests: Friendship[] = [];

      data.forEach(friendship => {
        const otherUserId = friendship.requester_id === user.id 
          ? friendship.addressee_id 
          : friendship.requester_id;
        const profile = profileMap.get(otherUserId);

        const enrichedFriendship: Friendship = {
          ...friendship,
          status: friendship.status as FriendshipStatus,
          profile: {
            user_id: otherUserId,
            name: profile?.name || 'Unknown',
            avatar_url: profile?.avatar_url || null,
          },
        };

        if (friendship.status === 'accepted') {
          friends.push(enrichedFriendship);
        } else if (friendship.status === 'pending') {
          if (friendship.requester_id === user.id) {
            pending.push(enrichedFriendship);
          } else {
            requests.push(enrichedFriendship);
          }
        }
      });

      return { friends, pending, requests };
    },
    enabled: !!user,
  });
}

export function useFriendshipStatus(otherUserId: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['friendship-status', otherUserId],
    queryFn: async () => {
      if (!user || !otherUserId || user.id === otherUserId) return null;

      const { data, error } = await supabase
        .from('friendships')
        .select('*')
        .or(`and(requester_id.eq.${user.id},addressee_id.eq.${otherUserId}),and(requester_id.eq.${otherUserId},addressee_id.eq.${user.id})`)
        .maybeSingle();

      if (error) throw error;
      return data;
    },
    enabled: !!user && !!otherUserId && user.id !== otherUserId,
  });
}

export const MAX_FRIENDS_PER_USER = 5000;

export function useSendFriendRequest() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (addresseeId: string) => {
      if (!user) throw new Error('Not authenticated');

      // Check friend count for requester
      const { count: requesterCount } = await supabase
        .from('friendships')
        .select('*', { count: 'exact', head: true })
        .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`)
        .eq('status', 'accepted');

      if ((requesterCount ?? 0) >= MAX_FRIENDS_PER_USER) {
        throw new Error(`Vous avez atteint la limite de ${MAX_FRIENDS_PER_USER} amis.`);
      }

      // Check friend count for addressee
      const { count: addresseeCount } = await supabase
        .from('friendships')
        .select('*', { count: 'exact', head: true })
        .or(`requester_id.eq.${addresseeId},addressee_id.eq.${addresseeId}`)
        .eq('status', 'accepted');

      if ((addresseeCount ?? 0) >= MAX_FRIENDS_PER_USER) {
        throw new Error('Cet utilisateur a atteint sa limite d\'amis.');
      }

      const { data, error } = await supabase
        .from('friendships')
        .insert({
          requester_id: user.id,
          addressee_id: addresseeId,
        })
        .select()
        .single();

      if (error) throw error;

      // Create notification
      await supabase.from('notifications').insert({
        user_id: addresseeId,
        type: 'friend_request',
        actor_id: user.id,
      });

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['friendships'] });
      queryClient.invalidateQueries({ queryKey: ['friendship-status'] });
    },
  });
}

export function useRespondToFriendRequest() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ friendshipId, accept }: { friendshipId: string; accept: boolean }) => {
      if (!user) throw new Error('Not authenticated');

      // If accepting, check both users' friend limits
      if (accept) {
        const { count: myCount } = await supabase
          .from('friendships')
          .select('*', { count: 'exact', head: true })
          .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`)
          .eq('status', 'accepted');

        if ((myCount ?? 0) >= MAX_FRIENDS_PER_USER) {
          throw new Error(`Vous avez atteint la limite de ${MAX_FRIENDS_PER_USER} amis.`);
        }
      }

      const { data, error } = await supabase
        .from('friendships')
        .update({ status: accept ? 'accepted' : 'rejected' })
        .eq('id', friendshipId)
        .select()
        .single();

      if (error) throw error;

      // Notify the requester if accepted
      if (accept && data) {
        await supabase.from('notifications').insert({
          user_id: data.requester_id,
          type: 'friend_accepted',
          actor_id: user.id,
        });
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['friendships'] });
      queryClient.invalidateQueries({ queryKey: ['friendship-status'] });
    },
  });
}

export function useRemoveFriend() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (friendshipId: string) => {
      const { error } = await supabase
        .from('friendships')
        .delete()
        .eq('id', friendshipId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['friendships'] });
      queryClient.invalidateQueries({ queryKey: ['friendship-status'] });
    },
  });
}
